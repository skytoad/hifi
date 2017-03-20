"use strict";
//
//  makeUserConnetion.js
//  scripts/system
//
//  Created by David Kelly on 3/7/2017.
//  Copyright 2017 High Fidelity, Inc.
//
//  Distributed under the Apache License, Version 2.0.
//  See the accompanying file LICENSE or http://www.apache.org/licenses/LICENSE-2.0.html
//
(function() { // BEGIN LOCAL_SCOPE

const version = 0.1;
const label = "makeUserConnection";
const MAX_AVATAR_DISTANCE = 0.5;
const GRIP_MIN = 0.05;
const MESSAGE_CHANNEL = "io.highfidelity.makeUserConnection";
const STATES = {
    inactive : 0,
    waiting: 1,
    friending: 2,
    makingFriends: 3
};
const STATE_STRINGS = ["inactive", "waiting", "friending", "makingFriends"];
const WAITING_INTERVAL = 100; // ms
const FRIENDING_INTERVAL = 100; // ms
const MAKING_FRIENDS_TIMEOUT = 1000; // ms
const FRIENDING_TIME = 2000; // ms
const FRIENDING_HAPTIC_STRENGTH = 0.5;
const FRIENDING_SUCCESS_HAPTIC_STRENGTH = 1.0;
const HAPTIC_DURATION = 20;
const PARTICLE_RADIUS = 0.2;
const PARTICLE_ANGLE_INCREMENT = 360/45;
const MODEL_URL = "http://hifi-content.s3.amazonaws.com/alan/dev/Test/sphere-3-color.fbx";
const TEXTURES = [
    {"Texture": "http://hifi-content.s3.amazonaws.com/alan/dev/Test/sphere-3-color.fbx/sphere-3-color.fbm/green-50pct-opaque-64.png"},
    {"Texture": "http://hifi-content.s3.amazonaws.com/alan/dev/Test/sphere-3-color.fbx/sphere-3-color.fbm/blue-50pct-opaque-64.png"},
    {"Texture": "http://hifi-content.s3.amazonaws.com/alan/dev/Test/sphere-3-color.fbx/sphere-3-color.fbm/red-50pct-opaque-64.png"}
];
const PARTICLE_EFFECT_PROPS = {
    "alpha": 0.8,
    "azimuthFinish": Math.PI,
    "azimuthStart": -1*Math.PI,
    "emitRate": 220,
    "emitSpeed": 0.0,
    "emitterShouldTrail": 1,
    "isEmitting": 1,
    "lifespan": 3,
    "maxParticles": 1000,
    "particleRadius": 0.003,
    "polarStart": 1,
    "polarFinish": 1,
    "radiusFinish": 0.006,
    "radiusStart": 0.001,
    "speedSpread": 0.025,
    "textures": "http://hifi-content.s3.amazonaws.com/alan/dev/Particles/Bokeh-Particle.png",
    "color": {"red": 255, "green": 255, "blue": 255},
    "colorFinish": {"red": 0, "green": 164, "blue": 255},
    "colorStart": {"red": 255, "green": 255, "blue": 255},
    "emitOrientation": {"w": -0.71, "x":0.0, "y":0.0, "z": 0.71},
    "emitAcceleration": {"x": 0.0, "y": 0.0, "z": 0.0},
    "accelerationSpread": {"x": 0.0, "y": 0.0, "z": 0.0},
    "dimensions": {"x":0.05, "y": 0.05, "z": 0.05},
    "type": "ParticleEffect"
};

var currentHand;
var state = STATES.inactive;
var friendingInterval;
var waitingInterval;
var makingFriendsTimeout;
var overlay;
var animHandlerId;
var friendingId;
var friendingHand;
var waitingList = {};
var particleEffect;
var waitingBallScale;
var particleRotationAngle = 0.0;

function debug() {
    var stateString = "<" + STATE_STRINGS[state] + ">";
    var versionString = "v" + version;
    var friending = "[" + friendingId + "/" + friendingHand + "]";
    print.apply(null, [].concat.apply([label, versionString, stateString, JSON.stringify(waitingList), friending], [].map.call(arguments, JSON.stringify)));
}

function handToString(hand) {
    if (hand === Controller.Standard.RightHand) {
        return "RightHand";
    } else if (hand === Controller.Standard.LeftHand) {
        return "LeftHand";
    }
    return "";
}

function stringToHand(hand) {
    if (hand == "RightHand") {
        return Controller.Standard.RightHand;
    } else if (hand == "LeftHand") {
        return Controller.Standard.LeftHand;
    }
    debug("stringToHand called with bad hand string:", hand);
    return 0;
}

function handToHaptic(hand) {
    if (hand === Controller.Standard.RightHand) {
        return 1;
    } else if (hand === Controller.Standard.LeftHand) {
        return 0;
    }
    return -1;
}

function stopWaiting() {
    if (waitingInterval) {
        waitingInterval = Script.clearInterval(waitingInterval);
    }
}

function stopFriending() {
    if (friendingInterval) {
        friendingInterval = Script.clearInterval(friendingInterval);
    }
}

function stopMakingFriends() {
    if (makingFriendsTimeout) {
        makingFriendsTimeout = Script.clearTimeout(makingFriendsTimeout);
    }
}

// This returns the position of the palm, really.  Which relies on the avatar
// having the expected middle1 joint.  TODO: fallback for when this isn't part
// of the avatar?
function getHandPosition(avatar, hand) {
    if (!hand) {
        debug("calling getHandPosition with no hand! (returning avatar position but this is a BUG)");
        debug(new Error().stack);
        return avatar.position;
    }
    var jointName = handToString(hand) + "Middle1";
    return avatar.getJointPosition(avatar.getJointIndex(jointName));
}

function shakeHandsAnimation(animationProperties) {
    // all we are doing here is moving the right hand to a spot
    // that is in front of and a bit above the hips.  Basing how
    // far in front as scaling with the avatar's height (say hips
    // to head distance)
    var headIndex = MyAvatar.getJointIndex("Head");
    var offset = 0.5; // default distance of hand in front of you
    var result = {};
    if (headIndex) {
        offset = 0.8 * MyAvatar.getAbsoluteJointTranslationInObjectFrame(headIndex).y;
    }
    var handPos = Vec3.multiply(offset, {x: -0.25, y: 0.8, z: 1.3});
    result.rightHandPosition = handPos;
    result.rightHandRotation = Quat.fromPitchYawRollDegrees(90, 0, 90);
    return result;
}

function positionFractionallyTowards(posA, posB, frac) {
    return Vec3.sum(posA, Vec3.multiply(frac, Vec3.subtract(posB, posA)));
}

function deleteOverlay() {
    if (overlay) {
        overlay = Overlays.deleteOverlay(overlay);
    }
}

function deleteParticleEffect() {
    if (particleEffect) {
        particleEffect = Entities.deleteEntity(particleEffect);
    }
}

// this is called frequently, but usually does nothing
function updateVisualization() {
    // after making friends, if you are still holding the grip lets transition
    // back to waiting
    if (state == STATES.makingFriends && !friendingId) {
        startHandshake();
        return;
    }
    if (state == STATES.inactive) {
        deleteOverlay();
        deleteParticleEffect();
        return;
    }

    var textures = TEXTURES[state-1];
    var myHandPosition = getHandPosition(MyAvatar, currentHand);
    var position = myHandPosition;
    var otherHand;
    if (friendingId) {
        var other = AvatarList.getAvatar(friendingId);
        if (other) {
            otherHand = getHandPosition(other, stringToHand(friendingHand));
        }
    }
    // scale the dimensions of the waiting/makingFriends ball to hand, capping
    // at MAX_AVATAR_DISTANCE if someone happens to be huge
    var wrist = MyAvatar.getJointPosition(MyAvatar.getJointIndex(handToString(currentHand)));
    var d = Math.min(MAX_AVATAR_DISTANCE, Vec3.distance(wrist, position));
    if (state != STATES.friending) {
        deleteParticleEffect();
        var dimension = {x: d, y: d, z: d};
        if (!overlay) {
            waitingBallScale = (state == STATES.waiting ? 1.0/32.0 : 1.0);
            var props =  {
                url: MODEL_URL,
                position: myHandPosition,
                dimensions: Vec3.multiply(waitingBallScale, dimension),
                textures: textures
            };
            overlay = Overlays.addOverlay("model", props);
        } else {
            waitingBallScale = Math.min(1.0, waitingBallScale * 1.1);
            Overlays.editOverlay(overlay, {textures: textures});
            Overlays.editOverlay(overlay, {dimensions: Vec3.multiply(waitingBallScale, dimension), position: state == STATES.waiting ? myHandPosition : otherHand});
        }
    } else {
        deleteOverlay();
        var particleProps = {};
        // put the position between the 2 hands, if we have a friendingId.  This
        // helps define the plane in which the particles move.
        position = positionFractionallyTowards(position, otherHand, 0.5);
        particleProps.position = position;
        // now manage the rest of the entity
        if (!particleEffect) {
            particleRotationAngle = 0.0;
            particleProps = PARTICLE_EFFECT_PROPS;
            particleEffect = Entities.addEntity(particleProps);
        } else {
            particleRotationAngle += PARTICLE_ANGLE_INCREMENT; // about 1 hz
            particleProps.position = Vec3.sum(position, Vec3.multiplyQbyV(Quat.angleAxis(particleRotationAngle, Quat.getFront(MyAvatar.orientation)), {x:0, y:PARTICLE_RADIUS, z:0}));
            Entities.editEntity(particleEffect, particleProps);
        }
    }
}

function isNearby(id, hand) {
    if (currentHand) {
        var handPos = getHandPosition(MyAvatar, currentHand);
        var avatar = AvatarList.getAvatar(id);
        if (avatar) {
            var otherHand = stringToHand(hand);
            var distance = Vec3.distance(getHandPosition(avatar, otherHand), handPos);
            return (distance < MAX_AVATAR_DISTANCE);
        }
    }
    return false;
}

function findNearestWaitingAvatar() {
    var handPos = getHandPosition(MyAvatar, currentHand);
    var minDistance = MAX_AVATAR_DISTANCE;
    var nearestAvatar = {};
    Object.keys(waitingList).forEach(function (identifier) {
        var avatar = AvatarList.getAvatar(identifier);
        if (avatar) {
            var hand = stringToHand(waitingList[identifier]);
            var distance = Vec3.distance(getHandPosition(avatar, hand), handPos);
            if (distance < minDistance) {
                minDistance = distance;
                nearestAvatar = {avatar: identifier, hand: hand};
            }
        }
    });
    return nearestAvatar;
}


// As currently implemented, we select the closest waiting avatar (if close enough) and send
// them a friendRequest.  If nobody is close enough we send a waiting message, and wait for a
// friendRequest.  If the 2 people who want to connect are both somewhat out of range when they
// initiate the shake, they will race to see who sends the friendRequest after noticing the
// waiting message.  Either way, they will start friending eachother at that point.
function startHandshake(fromKeyboard) {
    if (fromKeyboard) {
        debug("adding animation");
        // just in case order of press/unpress is broken
        if (animHandlerId) {
            animHandlerId = MyAvatar.removeAnimationStateHandler(animHandlerId);
        }
        animHandlerId = MyAvatar.addAnimationStateHandler(shakeHandsAnimation, []);
    }
    debug("starting handshake for", currentHand);
    state = STATES.waiting;
    friendingId = undefined;
    friendingHand = undefined;
    // just in case
    stopWaiting();
    stopFriending();
    stopMakingFriends();

    var nearestAvatar = findNearestWaitingAvatar();
    if (nearestAvatar.avatar) {
        friendingId = nearestAvatar.avatar;
        friendingHand = handToString(nearestAvatar.hand);
        debug("sending friendRequest to", friendingId);
        messageSend({
            key: "friendRequest",
            id: friendingId,
            hand: handToString(currentHand)
        });
    } else {
        // send waiting message
        debug("sending waiting message");
        messageSend({
            key: "waiting",
            hand: handToString(currentHand)
        });
        lookForWaitingAvatar();
    }
}

function endHandshake() {
    debug("ending handshake for", currentHand);
    currentHand = undefined;
    // note that setting the state to inactive should really
    // only be done here, unless we change how the triggering works,
    // as we ignore the key release event when inactive.  See updateTriggers
    // below.
    state = STATES.inactive;
    friendingId = undefined;
    friendingHand = undefined;
    stopWaiting();
    stopFriending();
    stopMakingFriends();
    // send done to let friend know you are not making friends now
    messageSend({
        key: "done"
    });

    if (animHandlerId) {
        debug("removing animation");
        MyAvatar.removeAnimationStateHandler(animHandlerId);
    }
}

function updateTriggers(value, fromKeyboard, hand) {
    if (currentHand && hand !== currentHand) {
        debug("currentHand", currentHand, "ignoring messages from", hand);
        return;
    }
    if (!currentHand) {
        currentHand = hand;
    }
    // ok now, we are either initiating or quitting...
    var isGripping = value > GRIP_MIN;
    if (isGripping) {
        if (state != STATES.inactive) {
            return;
        } else {
            startHandshake(fromKeyboard);
        }
    } else {
        // TODO: should we end handshake even when inactive?  Ponder
        if (state != STATES.inactive) {
            endHandshake();
        } else {
            return;
        }
    }
}

function messageSend(message) {
    Messages.sendMessage(MESSAGE_CHANNEL, JSON.stringify(message));
}

function lookForWaitingAvatar() {
    // we started with nobody close enough, but maybe I've moved
    // or they did.  Note that 2 people doing this race, so stop
    // as soon as you have a friendingId (which means you got their
    // message before noticing they were in range in this loop)

    // just in case we reenter before stopping
    stopWaiting();
    debug("started looking for waiting avatars");
    waitingInterval = Script.setInterval(function () {
        if (state == STATES.waiting && !friendingId) {
            // find the closest in-range avatar, and send friend request
            // TODO: this is same code as in startHandshake - get this
            // cleaned up.
            var nearestAvatar = findNearestWaitingAvatar();
            if (nearestAvatar.avatar) {
                friendingId = nearestAvatar.avatar;
                friendingHand = handToString(nearestAvatar.hand);
                debug("sending friendRequest to", friendingId);
                messageSend({
                    key: "friendRequest",
                    id: friendingId,
                    hand: handToString(currentHand)
                });
            }
        } else {
            // something happened, stop looking for avatars to friend
            stopWaiting();
            debug("stopped looking for waiting avatars");
        }
    }, WAITING_INTERVAL);
}

// this should be where we make the appropriate friend call.  For now just make the
// visualization change.
function makeFriends(id) {
    // send done to let the friend know you have made friends.
    messageSend({
        key: "done",
        friendId: id
    });
    Controller.triggerHapticPulse(FRIENDING_SUCCESS_HAPTIC_STRENGTH, HAPTIC_DURATION, handToHaptic(currentHand));
    state = STATES.makingFriends;
    // now that we made friends, reset everything
    makingFriendsTimeout = Script.setTimeout(function () {
            friendingId = undefined;
            friendingHand = undefined;
            makingFriendsTimeout = undefined;
        }, MAKING_FRIENDS_TIMEOUT);
}

// we change states, start the friendingInterval where we check
// to be sure the hand is still close enough.  If not, we terminate
// the interval, go back to the waiting state.  If we make it
// the entire FRIENDING_TIME, we make friends.
function startFriending(id, hand) {
    var count = 0;
    debug("friending", id, "hand", hand);
    // do we need to do this?
    friendingId = id;
    friendingHand = hand;
    state = STATES.friending;
    Controller.triggerHapticPulse(FRIENDING_HAPTIC_STRENGTH, HAPTIC_DURATION, handToHaptic(currentHand));

    // send message that we are friending them
    messageSend({
        key: "friending",
        id: id,
        hand: handToString(currentHand)
    });

    friendingInterval = Script.setInterval(function () {
        count += 1;
        if (state != STATES.friending) {
            debug("stopping friending interval, state changed");
            stopFriending();
        } else if (!isNearby(id, hand)) {
            // gotta go back to waiting
            debug(id, "moved, back to waiting");
            stopFriending();
            messageSend({
                key: "done"
            });
            startHandshake();
        } else if (count > FRIENDING_TIME/FRIENDING_INTERVAL) {
            debug("made friends with " + id);
            makeFriends(id);
            stopFriending();
        }
    }, FRIENDING_INTERVAL);
}
/*
A simple sequence diagram: NOTE that the FriendAck is somewhat
vestigial, and probably should be removed shortly.

     Avatar A                       Avatar B
        |                               |
        |  <-----(waiting) ----- startHandshake
   startHandshake -- (FriendRequest) -> |
        |                               |
        | <-------(FriendAck) --------- |
        | <--------(friending) -- startFriending
   startFriending -- (friending) --->   |
        |                               |
        |                            friends
     friends                            |
        | <---------  (done) ---------- |
        | ---------- (done) --------->  |
*/
function messageHandler(channel, messageString, senderID) {
    if (channel !== MESSAGE_CHANNEL) {
        return;
    }
    if (MyAvatar.sessionUUID === senderID) { // ignore my own
        return;
    }
    var message = {};
    try {
        message = JSON.parse(messageString);
    } catch (e) {
        debug(e);
    }
    switch (message.key) {
    case "waiting":
        // add this guy to waiting object.  Any other message from this person will
        // remove it from the list
        waitingList[senderID] = message.hand;
        break;
    case "friendRequest":
        delete waitingList[senderID];
        if (state == STATES.waiting && message.id == MyAvatar.sessionUUID && (!friendingId || friendingId == senderID)) {
            // you were waiting for a friend request, so send the ack.  Or, you and the other
            // guy raced and both send friendRequests.  Handle that too
            friendingId = senderID;
            friendingHand = message.hand;
            messageSend({
                key: "friendAck",
                id: senderID,
                hand: handToString(currentHand)
            });
        } else {
            if (state == STATES.waiting && friendingId == senderID) {
                // the person you are trying to friend sent a request to someone else.  See the
                // if statement above.  So, don't cry, just start the handshake over again
                startHandshake();
            }
        }
        break;
    case "friendAck":
        delete waitingList[senderID];
        if (state == STATES.waiting && (!friendingId || friendingId == senderID)) {
            if (message.id == MyAvatar.sessionUUID) {
                // start friending...
                friendingId = senderID;
                friendingHand = message.hand;
                stopWaiting();
                startFriending(senderID, message.hand);
            } else {
                if (friendingId) {
                    // this is for someone else (we lost race in friendRequest),
                    // so lets start over
                    startHandshake();
                }
            }
        }
        // TODO: check to see if we are waiting for this but the person we are friending sent it to
        // someone else, and try again
        break;
    case "friending":
        delete waitingList[senderID];
        if (state == STATES.waiting && senderID == friendingId) {
            // temporary logging
            if (friendingHand != message.hand) {
                debug("friending hand", friendingHand, "not same as friending hand in message", message.hand);
            }
            friendingHand = message.hand;
            if (message.id != MyAvatar.sessionUUID) {
                // the person we were trying to friend is friending someone else
                // so try again
                startHandshake();
                break;
            }
            startFriending(senderID, message.hand);
        }
        break;
    case "done":
        delete waitingList[senderID];
        if (state == STATES.friending && friendingId == senderID) {
            // if they are done, and didn't friend us, terminate our
            // friending
            if (message.friendId !== MyAvatar.sessionUUID) {
                stopFriending();
                // now just call startHandshake.  Should be ok to do so without a
                // value for isKeyboard, as we should not change the animation
                // state anyways (if any)
                startHandshake();
            }
        } else {
            // if waiting or inactive, lets clear the friending id. If in makingFriends,
            // do nothing (so you see the red for a bit)
            if (state != STATES.makingFriends && friendingId == senderID) {
                friendingId = undefined;
                friendingHand = undefined;
                if (state != STATES.inactive) {
                    startHandshake();
                }
            }
        }
        break;
    default:
        debug("unknown message", message);
        break;
    }
}

Messages.subscribe(MESSAGE_CHANNEL);
Messages.messageReceived.connect(messageHandler);


function makeGripHandler(hand, animate) {
    // determine if we are gripping or un-gripping
    if (animate) {
        return function(value) {
            updateTriggers(value, true, hand);
        };

    } else {
        return function (value) {
            updateTriggers(value, false, hand);
        };
    }
}

function keyPressEvent(event) {
    if ((event.text === "x") && !event.isAutoRepeat) {
        updateTriggers(1.0, true, Controller.Standard.RightHand);
    }
}
function keyReleaseEvent(event) {
    if ((event.text === "x") && !event.isAutoRepeat) {
        updateTriggers(0.0, true, Controller.Standard.RightHand);
    }
}
// map controller actions
var friendsMapping = Controller.newMapping(Script.resolvePath('') + '-grip');
friendsMapping.from(Controller.Standard.LeftGrip).peek().to(makeGripHandler(Controller.Standard.LeftHand));
friendsMapping.from(Controller.Standard.RightGrip).peek().to(makeGripHandler(Controller.Standard.RightHand));

// setup keyboard initiation
Controller.keyPressEvent.connect(keyPressEvent);
Controller.keyReleaseEvent.connect(keyReleaseEvent);

// xbox controller cuz that's important
friendsMapping.from(Controller.Standard.RB).peek().to(makeGripHandler(Controller.Standard.RightHand, true));

// it is easy to forget this and waste a lot of time for nothing
friendsMapping.enable();

// connect updateVisualization to update frequently
Script.update.connect(updateVisualization);

Script.scriptEnding.connect(function () {
    debug("removing controller mappings");
    friendsMapping.disable();
    debug("removing key mappings");
    Controller.keyPressEvent.disconnect(keyPressEvent);
    Controller.keyReleaseEvent.disconnect(keyReleaseEvent);
    debug("disconnecting updateVisualization");
    Script.update.disconnect(updateVisualization);
    deleteOverlay();
    deleteParticleEffect();
});

}()); // END LOCAL_SCOPE
