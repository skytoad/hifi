import QtQuick 2.5
import QtQuick.Controls 1.4
import QtWebEngine 1.1

import Qt.labs.settings 1.0

import "windows" as Windows
import "controls" as Controls

Windows.Window {
    id: toolWindow
    resizable: true
    objectName: "ToolWindow"
    destroyOnCloseButton: false
    destroyOnInvisible: false
    visible: false
    property string newTabSource
    property alias tabView: tabView
    onParentChanged: {
        x = desktop.width / 2 - width / 2;
        y = desktop.height / 2 - height / 2;
    }

    Settings {
        category: "ToolWindow.Position"
        property alias x: toolWindow.x
        property alias y: toolWindow.y
    }

    property var webTabCreator: Component {
        Controls.WebView {
            id: webView
            property string originalUrl;

            // Both toolWindow.newTabSource and url can change, so we need
            // to store the original url here, without creating any bindings
            Component.onCompleted: {
                originalUrl = toolWindow.newTabSource;
                url = originalUrl;
            }
        }
    }

    TabView {
        id: tabView; width: 384; height: 640;
        onCountChanged: {
            if (0 == count) {
                toolWindow.visible = false
            }
        }
    }

    function updateVisiblity() {
        var newVisible = false
        console.log("Checking " + tabView.count + " children")
        for (var i = 0; i < tabView.count; ++i) {
            if (tabView.getTab(i).enabled) {
                console.log("Tab " + i + " enabled");
                newVisible = true;
                break;
            }
        }
        console.log("Setting toolWindow visible: " + newVisible);
        visible = newVisible
    }

    function findIndexForUrl(source) {
        for (var i = 0; i < tabView.count; ++i) {
            var tab = tabView.getTab(i);
            if (tab && tab.item && tab.item.originalUrl &&
                tab.item.originalUrl === source) {
                return i;
            }
        }
        return -1;
    }

    function removeTabForUrl(source) {
        var index = findIndexForUrl(source);
        if (index < 0) {
            console.warn("Could not find tab for " + source);
            return;
        }
        tabView.removeTab(index);
        console.log("Updating visibility based on child tab removed");
        updateVisiblity();
    }

    function addWebTab(properties) {
        if (!properties.source) {
            console.warn("Attempted to open Web Tool Pane without URl")
            return;
        }

        var existingTabIndex = findIndexForUrl(properties.source);
        if (existingTabIndex >= 0) {
            console.log("Existing tab " + existingTabIndex + " found with URL " + properties.source)
            return tabView.getTab(existingTabIndex);
        }

        var title = properties.title || "Unknown";
        newTabSource = properties.source;
        console.log(typeof(properties.source))
        var newTab = tabView.addTab(title, webTabCreator);
        newTab.active = true;
        newTab.enabled = false;

        if (properties.width) {
            tabView.width = Math.min(Math.max(tabView.width, properties.width),
                                        toolWindow.maxSize.x);
        }

        if (properties.height) {
            tabView.height = Math.min(Math.max(tabView.height, properties.height),
                                        toolWindow.maxSize.y);
        }

        console.log("Updating visibility based on child tab added");
        newTab.enabledChanged.connect(function() {
            console.log("Updating visibility based on child tab enabled change");
            updateVisiblity();
        })
        updateVisiblity();
        return newTab
    }
}
