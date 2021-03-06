//
//  SignInBody.qml
//
//  Created by Clement on 7/18/16
//  Copyright 2015 High Fidelity, Inc.
//
//  Distributed under the Apache License, Version 2.0.
//  See the accompanying file LICENSE or http://www.apache.org/licenses/LICENSE-2.0.html
//

import Hifi 1.0
import QtQuick 2.4
import QtQuick.Controls.Styles 1.4 as OriginalStyles

import "../controls-uit"
import "../styles-uit"

Item {
    id: signInBody
    clip: true

    property bool required: false

    function login() {
        console.log("Trying to log in")
        loginDialog.loginThroughSteam()
    }

    function cancel() {
        bodyLoader.popup()
    }

    QtObject {
        id: d
        function resize() {}
    }

    InfoItem {
        id: mainTextContainer
        anchors {
            top: parent.top
            horizontalCenter: parent.horizontalCenter
            margins: 0
            topMargin: hifi.dimensions.contentSpacing.y
        }

        text: required ? qsTr("This domain's owner requires that you sign in:")
                       : qsTr("Sign in to access your user account:")
        wrapMode: Text.WordWrap
        color: hifi.colors.baseGrayHighlight
        lineHeight: 2
        lineHeightMode: Text.ProportionalHeight
        horizontalAlignment: Text.AlignHCenter
    }

    Row {
        id: buttons
        anchors {
            top: mainTextContainer.bottom
            horizontalCenter: parent.horizontalCenter
            margins: 0
            topMargin: 2 * hifi.dimensions.contentSpacing.y
        }
        spacing: hifi.dimensions.contentSpacing.x
        onHeightChanged: d.resize(); onWidthChanged: d.resize();

        Button {
            anchors.verticalCenter: parent.verticalCenter

            width: undefined // invalidate so that the image's size sets the width
            height: undefined // invalidate so that the image's size sets the height
            focus: true

            style: OriginalStyles.ButtonStyle {
                background: Image {
                    id: buttonImage
                    source: "../../images/steam-sign-in.png"
                }
            }
            onClicked: signInBody.login()
        }
        Button {
            anchors.verticalCenter: parent.verticalCenter

            text: qsTr("Cancel");

            onClicked: signInBody.cancel()
        }
    }

    Component.onCompleted: {
        loginDialogRoot.title = required ? qsTr("Sign In Required")
                              : qsTr("Sign In")
        loginDialogRoot.iconText = ""
        d.resize();
    }

    Connections {
        target: loginDialog
        onHandleLoginCompleted: {
            console.log("Login Succeeded")
            bodyLoader.setSource("WelcomeBody.qml", { "welcomeBack" : true })
        }
        onHandleLoginFailed: {
            console.log("Login Failed")
            bodyLoader.setSource("CompleteProfileBody.qml")
        }
    }
}
