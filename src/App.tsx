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
import {config} from './config';

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
  //   - streamingServerUrl: the self-hosted backend (see src/config.ts).
  //
  // Mirrors stremio-web's own "use this server" callback: dispatch AddServerUrl
  // (registers it in the server list so the app does NOT pop a confirm dialog
  // for a non-loopback URL), then UpdateSettings to select it. We do not read
  // localStorage — this build keeps the profile in the WASM core, so we spread
  // the live settings from the core model when we can and otherwise send just
  // the keys we are forcing. Re-applied on each load; no-ops once correct.
  var FORCED_SERVER_URL = '${config.streamingServerUrl}';
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (tries > 150) {
      clearInterval(timer); // give up after ~30s
      return;
    }
    var core = window.core;
    if (!core || typeof core.dispatch !== 'function') return;

    // Best-effort read of the live settings from the core model, so we spread
    // rather than clobber. Falls back to empty if the shape is not as expected.
    var settings = {};
    try {
      if (typeof core.getState === 'function') {
        var st = core.getState('ctx');
        if (st && st.profile && st.profile.settings) {
          settings = st.profile.settings;
        }
      }
    } catch (err) {
      /* fall through with empty settings */
    }

    if (
      settings.gamepadSupport === true &&
      settings.streamingServerUrl === FORCED_SERVER_URL
    ) {
      clearInterval(timer); // already as desired
      return;
    }

    try {
      // Register the server first so no confirm dialog is shown.
      core.dispatch({action: 'Ctx', args: {action: 'AddServerUrl', args: FORCED_SERVER_URL}});
      var next = Object.assign({}, settings, {
        gamepadSupport: true,
        streamingServerUrl: FORCED_SERVER_URL,
      });
      core.dispatch({action: 'Ctx', args: {action: 'UpdateSettings', args: next}});
      clearInterval(timer);
    } catch (err) {
      /* retry on next tick */
    }
  }, 200);
})();
true;
`;

// stremio-web reads a `streamingServerUrl` query parameter on load and, via its
// own code, adds + selects + connects that server (AddServerUrl + UpdateSettings).
// This is the robust, version-stable way to prefill the server — far more
// reliable than poking window.core from injected JS, which depends on the
// core transport being ready and on the exact action shape. The INIT_SCRIPT
// dispatch above stays as a belt-and-braces fallback (and for gamepadSupport).
const SOURCE_URI =
  `${config.baseUrl}?streamingServerUrl=` +
  encodeURIComponent(config.streamingServerUrl);

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
          // Self-hosted stremio-web served over HTTPS from the backend
          // (src/config.ts). The ?streamingServerUrl= query param makes
          // stremio-web add + connect the server itself on load — see
          // SOURCE_URI above. Same HTTPS origin as the streaming server, so no
          // mixed-content block and no host-local dependency.
          uri: SOURCE_URI,
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
