//
//  Application_render.cpp
//  interface/src
//
//  Copyright 2013 High Fidelity, Inc.
//
//  Distributed under the Apache License, Version 2.0.
//  See the accompanying file LICENSE or http://www.apache.org/licenses/LICENSE-2.0.html
//

#include "Application.h"
#include <MainWindow.h>

#include <display-plugins/CompositorHelper.h>
#include <FramebufferCache.h>
#include "ui/Stats.h"
#include "FrameTimingsScriptingInterface.h"
#include <SceneScriptingInterface.h>
#include "Util.h"

FrameTimingsScriptingInterface _frameTimingsScriptingInterface;

// Statically provided display and input plugins
extern DisplayPluginList getDisplayPlugins();

void Application::editRenderArgs(RenderArgsEditor editor) {
    QMutexLocker renderLocker(&_renderArgsMutex);
    editor(_appRenderArgs);

}

void Application::paintGL() {
    // Some plugins process message events, allowing paintGL to be called reentrantly.
    if (_aboutToQuit || _window->isMinimized()) {
        return;
    }

    _frameCount++;
    _lastTimeRendered.start();

    auto lastPaintBegin = usecTimestampNow();
    PROFILE_RANGE_EX(render, __FUNCTION__, 0xff0000ff, (uint64_t)_frameCount);
    PerformanceTimer perfTimer("paintGL");

    if (nullptr == _displayPlugin) {
        return;
    }

    DisplayPluginPointer displayPlugin;
    {
        PROFILE_RANGE(render, "/getActiveDisplayPlugin");
        displayPlugin = getActiveDisplayPlugin();
    }

    {
        PROFILE_RANGE(render, "/pluginBeginFrameRender");
        // If a display plugin loses it's underlying support, it
        // needs to be able to signal us to not use it
        if (!displayPlugin->beginFrameRender(_frameCount)) {
            updateDisplayMode();
            return;
        }
    }

    RenderArgs renderArgs;
    float sensorToWorldScale;
    glm::mat4  HMDSensorPose;
    glm::mat4  eyeToWorld;
    glm::mat4  sensorToWorld;

    bool isStereo;
    glm::mat4  stereoEyeOffsets[2];
    glm::mat4  stereoEyeProjections[2];

    {
        QMutexLocker viewLocker(&_renderArgsMutex);
        renderArgs = _appRenderArgs._renderArgs;
        HMDSensorPose = _appRenderArgs._headPose;
        eyeToWorld = _appRenderArgs._eyeToWorld;
        sensorToWorld = _appRenderArgs._sensorToWorld;
        sensorToWorldScale = _appRenderArgs._sensorToWorldScale;
        isStereo = _appRenderArgs._isStereo;
        for_each_eye([&](Eye eye) {
            stereoEyeOffsets[eye] = _appRenderArgs._eyeOffsets[eye];
            stereoEyeProjections[eye] = _appRenderArgs._eyeProjections[eye];
        });
    }

    {
        PROFILE_RANGE(render, "/gpuContextReset");
        _gpuContext->beginFrame(HMDSensorPose);
        // Reset the gpu::Context Stages
        // Back to the default framebuffer;
        gpu::doInBatch(_gpuContext, [&](gpu::Batch& batch) {
            batch.resetStages();
        });
    }


    {
        PROFILE_RANGE(render, "/renderOverlay");
        PerformanceTimer perfTimer("renderOverlay");
        // NOTE: There is no batch associated with this renderArgs
        // the ApplicationOverlay class assumes it's viewport is setup to be the device size
        QSize size = getDeviceSize();
        renderArgs._viewport = glm::ivec4(0, 0, size.width(), size.height());
        _applicationOverlay.renderOverlay(&renderArgs);
    }

    //   updateCamera(renderArgs);
    {
        PROFILE_RANGE(render, "/updateCompositor");
        //    getApplicationCompositor().setFrameInfo(_frameCount, _myCamera.getTransform(), getMyAvatar()->getSensorToWorldMatrix());
        getApplicationCompositor().setFrameInfo(_frameCount, eyeToWorld, sensorToWorld);
    }

    gpu::FramebufferPointer finalFramebuffer;
    QSize finalFramebufferSize;
    {
        PROFILE_RANGE(render, "/getOutputFramebuffer");
        // Primary rendering pass
        auto framebufferCache = DependencyManager::get<FramebufferCache>();
        finalFramebufferSize = framebufferCache->getFrameBufferSize();
        // Final framebuffer that will be handled to the display-plugin
        finalFramebuffer = framebufferCache->getFramebuffer();
    }

    {
        if (isStereo) {
            renderArgs._context->enableStereo(true);
            renderArgs._context->setStereoProjections(stereoEyeProjections);
            renderArgs._context->setStereoViews(stereoEyeOffsets);
        }

        renderArgs._blitFramebuffer = finalFramebuffer;
        runRenderFrame(&renderArgs);
    }

    gpu::Batch postCompositeBatch;
    {
        PROFILE_RANGE(render, "/postComposite");
        PerformanceTimer perfTimer("postComposite");
        renderArgs._batch = &postCompositeBatch;
        renderArgs._batch->setViewportTransform(ivec4(0, 0, finalFramebufferSize.width(), finalFramebufferSize.height()));
        renderArgs._batch->setViewTransform(renderArgs.getViewFrustum().getView());
        _overlays.render3DHUDOverlays(&renderArgs);
    }

    auto frame = _gpuContext->endFrame();
    frame->frameIndex = _frameCount;
    frame->framebuffer = finalFramebuffer;
    frame->framebufferRecycler = [](const gpu::FramebufferPointer& framebuffer) {
        DependencyManager::get<FramebufferCache>()->releaseFramebuffer(framebuffer);
    };
    frame->overlay = _applicationOverlay.getOverlayTexture();
    frame->postCompositeBatch = postCompositeBatch;
    // deliver final scene rendering commands to the display plugin
    {
        PROFILE_RANGE(render, "/pluginOutput");
        PerformanceTimer perfTimer("pluginOutput");
        _frameCounter.increment();
        displayPlugin->submitFrame(frame);
    }

    // Reset the framebuffer and stereo state
    renderArgs._blitFramebuffer.reset();
    renderArgs._context->enableStereo(false);

    {
        Stats::getInstance()->setRenderDetails(renderArgs._details);
    }

    uint64_t lastPaintDuration = usecTimestampNow() - lastPaintBegin;
    _frameTimingsScriptingInterface.addValue(lastPaintDuration);
}


// WorldBox Render Data & rendering functions

class WorldBoxRenderData {
public:
    typedef render::Payload<WorldBoxRenderData> Payload;
    typedef Payload::DataPointer Pointer;

    int _val = 0;
    static render::ItemID _item; // unique WorldBoxRenderData
};

render::ItemID WorldBoxRenderData::_item{ render::Item::INVALID_ITEM_ID };

namespace render {
    template <> const ItemKey payloadGetKey(const WorldBoxRenderData::Pointer& stuff) { return ItemKey::Builder::opaqueShape(); }
    template <> const Item::Bound payloadGetBound(const WorldBoxRenderData::Pointer& stuff) { return Item::Bound(); }
    template <> void payloadRender(const WorldBoxRenderData::Pointer& stuff, RenderArgs* args) {
        if (Menu::getInstance()->isOptionChecked(MenuOption::WorldAxes)) {
            PerformanceTimer perfTimer("worldBox");

            auto& batch = *args->_batch;
            DependencyManager::get<GeometryCache>()->bindSimpleProgram(batch);
            renderWorldBox(args, batch);
        }
    }
}

void Application::runRenderFrame(RenderArgs* renderArgs) {
    PROFILE_RANGE(render, __FUNCTION__);
    PerformanceTimer perfTimer("display");
    PerformanceWarning warn(Menu::getInstance()->isOptionChecked(MenuOption::PipelineWarnings), "Application::runRenderFrame()");

    // The pending changes collecting the changes here
    render::Transaction transaction;

    if (DependencyManager::get<SceneScriptingInterface>()->shouldRenderEntities()) {
        // render models...
        PerformanceTimer perfTimer("entities");
        PerformanceWarning warn(Menu::getInstance()->isOptionChecked(MenuOption::PipelineWarnings),
            "Application::runRenderFrame() ... entities...");

        RenderArgs::DebugFlags renderDebugFlags = RenderArgs::RENDER_DEBUG_NONE;

        if (Menu::getInstance()->isOptionChecked(MenuOption::PhysicsShowHulls)) {
            renderDebugFlags = static_cast<RenderArgs::DebugFlags>(renderDebugFlags |
                static_cast<int>(RenderArgs::RENDER_DEBUG_HULLS));
        }
        renderArgs->_debugFlags = renderDebugFlags;
    }

    // Make sure the WorldBox is in the scene
    // For the record, this one RenderItem is the first one we created and added to the scene.
    // We could meoee that code elsewhere but you know...
    if (!render::Item::isValidID(WorldBoxRenderData::_item)) {
        auto worldBoxRenderData = std::make_shared<WorldBoxRenderData>();
        auto worldBoxRenderPayload = std::make_shared<WorldBoxRenderData::Payload>(worldBoxRenderData);

        WorldBoxRenderData::_item = _main3DScene->allocateID();

        transaction.resetItem(WorldBoxRenderData::_item, worldBoxRenderPayload);
        _main3DScene->enqueueTransaction(transaction);
    }

    {
        PerformanceTimer perfTimer("EngineRun");
        _renderEngine->getRenderContext()->args = renderArgs;
        _renderEngine->run();
    }
}
