import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useEffect, useRef} from 'react';
import {View, StyleSheet, BackHandler} from 'react-native';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';
import {
  SslErrorData,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewMethods,
  WebViewNavigationEvent,
} from '@amazon-devices/webview/dist/types/WebViewTypes';

// Translate the Vega remote's Back/GoBack key into a synthetic Escape keydown
// inside the page. stremio-web was written for desktop browsers and closes
// modals / the player overlay on `event.key === 'Escape'`; on Vega the Back
// button arrives as `event.key === 'GoBack'` (keyCode 27), which stremio-web
// does not recognise. This shim lets in-page overlays dismiss on Back, while
// page-level history is handled natively by the RN BackHandler below.
// Injected into the page before content loads. Two concerns:
//
// 1. GoBack->Escape shim: stremio-web closes modals / the player overlay on
//    `event.key === 'Escape'`; Vega delivers the remote Back button as
//    `event.key === 'GoBack'` (keyCode 27), which the page does not recognise.
//    Page-level history is handled by the RN BackHandler below; this makes
//    in-page overlays dismiss on Back too.
//
// 2. Force gamepad support ON: the on-screen player control buttons only
//    respond to the remote when stremio-web's "gamepad support" interface
//    setting is enabled (profile.settings.gamepadSupport). We force it on at
//    every launch so it is never a manual step. stremio-core exposes its
//    transport as `window.core` once initialised (set in CoreProvider), and
//    persists the profile to localStorage under the "profile" key. We poll for
//    the transport and dispatch the exact Ctx/UpdateSettings action the
//    Settings toggle uses, spreading the current settings so nothing else is
//    disturbed.
const INIT_SCRIPT = `
(function () {
  if (window.__vegaInit) return;
  window.__vegaInit = true;

  // (1) Back button -> Escape for in-page overlays.
  document.addEventListener(
    'keydown',
    function (e) {
      if (e.key === 'GoBack' || e.keyCode === 27) {
        var esc = new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(esc);
      }
    },
    true,
  );

  // (2) Force player settings once the core transport is available:
  //   - gamepadSupport: on, so the remote drives the on-screen controls.
  //   - streamingServerUrl: point at the Stremio streaming server running on
  //     the host (reachable from the Vega Virtual Device at 10.0.2.2, the
  //     QEMU host gateway). Without a streaming server, most addon/torrent
  //     streams are handed to the player un-remuxed and stall on Vega's W3C
  //     media pipeline (poster -> black, time advances, no frames).
  var FORCED_SERVER_URL = 'http://10.0.2.2:11470/';
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (tries > 150) {
      clearInterval(timer); // give up after ~30s
      return;
    }
    var core = window.core;
    if (!core || typeof core.dispatch !== 'function') return;

    var settings = {};
    try {
      var stored = window.localStorage.getItem('profile');
      if (stored) {
        var profile = JSON.parse(stored);
        if (profile && profile.settings) {
          settings = profile.settings;
          if (
            settings.gamepadSupport === true &&
            settings.streamingServerUrl === FORCED_SERVER_URL
          ) {
            clearInterval(timer); // already as desired, nothing to do
            return;
          }
        }
      }
    } catch (err) {
      /* fall through with empty settings */
    }

    var next = Object.assign({}, settings, {
      gamepadSupport: true,
      streamingServerUrl: FORCED_SERVER_URL,
    });
    try {
      core.dispatch({
        action: 'Ctx',
        args: {action: 'UpdateSettings', args: next},
      });
      clearInterval(timer);
    } catch (err) {
      /* retry on next tick */
    }
  }, 200);
})();
true;
`;

export const App = () => {
  const webRef = useRef<WebViewMethods | null>(null);
  const canGoBackRef = useRef(false);
  // By default splash screen is shown in app launch, as the splash
  // screen images are bundled in this app (assets/raw/ folder)
  // Declare that application wants to extend splash screen lifecycle
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  // Hardware Back button: navigate WebView history when possible, otherwise
  // let the system handle it (app exit). This is the Vega-recommended path —
  // relying on the page alone does not work because stremio-web listens for
  // Escape, not GoBack.
  useEffect(() => {
    const onBackPress = (): boolean => {
      if (canGoBackRef.current && webRef.current) {
        webRef.current.goBack();
        return true; // consumed
      }
      return false; // allow default (exit)
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, []);

  const onLoad = useCallback(
    (event: WebViewNavigationEvent) => {
      canGoBackRef.current = event.nativeEvent.canGoBack;
      console.info('Page loading completed...');
      hideSplashScreenCallback();
    },
    [hideSplashScreenCallback],
  );

  const onLoadStart = useCallback((event: WebViewNavigationEvent) => {
    canGoBackRef.current = event.nativeEvent.canGoBack;
    console.info('Page loading started...');
  }, []);

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        style={styles.webview}
        allowSystemKeyEvents
        allowsDefaultMediaControl
        domStorageEnabled
        hasTVPreferredFocus
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="compatibility"
        injectedJavaScriptBeforeContentLoaded={INIT_SCRIPT}
        // thirdPartyCookiesEnabled
        // userAgent={''}
        source={{
          // headers: {},
          uri: 'https://web.stremio.com',
        }}
        onLoad={onLoad}
        onLoadStart={onLoadStart}
        onMessage={(event: WebViewMessageEvent) => {
          // Reserved for an in-page EXIT_APP bridge if needed later.
          if (event.nativeEvent.data === 'EXIT_APP') {
            BackHandler.exitApp();
          }
        }}
        onCloseWindow={() => {
          // Window close requested by the platform / page — exit cleanly.
          BackHandler.exitApp();
        }}
        onError={({
          nativeEvent: {code, url, description},
        }: WebViewErrorEvent) => {
          console.error(`[onError]: (${code}: ${url}) ${description}`);
        }}
        onHttpError={({
          nativeEvent: {url, statusCode: code, description, isMainFrame},
        }: WebViewHttpErrorEvent) => {
          console.error(`[onHttpError]: (${code}: ${url}) ${description}`);
          console.error(`[onHttpError]: isMainFrame: ${isMainFrame}`);
        }}
        onSslError={({code, url, description}: SslErrorData) => {
          console.error(`[onSslError]: (${code}: ${url}) ${description}`);
        }}
      />
    </View>
  );
};

// Styles for layout, which are necessary for proper focus behavior
const styles = StyleSheet.create({
  container: {flex: 1},
  webview: {backgroundColor: '#000000'},
});
