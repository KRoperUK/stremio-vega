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

// The app we load is our OWN web client (built from /app and served by the
// streaming server at config.baseUrl over HTTPS). The web app owns the back
// stack: it listens for a GoBack/Escape keydown, pops one view, and only when
// already at the root posts 'EXIT_APP' back to us to close the app.
//
// Because the app is a single page (no WebView history), we must NOT drive
// WebView.goBack() on the hardware Back key. Instead the native Back key is
// forwarded into the page as a GoBack keydown (see onBackPress below), so the
// web app's single handler decides every time whether to pop a view or exit.
const INIT_SCRIPT = `
(function () {
  if (window.__vegaInit) return;
  window.__vegaInit = true;
  // Let the host (RN) deliver Back by calling window.__vegaBack(); it
  // dispatches a GoBack keydown the app already listens for.
  window.__vegaBack = function () {
    var ev = new KeyboardEvent('keydown', {
      key: 'GoBack', code: 'GoBack', keyCode: 27, which: 27,
      bubbles: true, cancelable: true,
    });
    document.dispatchEvent(ev);
  };
})();
true;
`;

export const App = () => {
  const webRef = useRef<WebViewMethods | null>(null);
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  // Hardware Back: forward into the web app, which owns the back stack and
  // decides whether to pop a view or request exit (via the EXIT_APP message).
  // We always return true so the system never exits the app out from under the
  // web app's own navigation.
  useEffect(() => {
    const onBackPress = (): boolean => {
      webRef.current?.injectJavaScript('window.__vegaBack && window.__vegaBack(); true;');
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, []);

  const onLoad = useCallback(
    (_event: WebViewNavigationEvent) => {
      console.info('Page loading completed...');
      hideSplashScreenCallback();
    },
    [hideSplashScreenCallback],
  );

  const onLoadStart = useCallback((_event: WebViewNavigationEvent) => {
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
        source={{
          // Our own web client, served over HTTPS by the streaming server.
          uri: config.baseUrl,
        }}
        onLoad={onLoad}
        onLoadStart={onLoadStart}
        onMessage={(event: WebViewMessageEvent) => {
          if (event.nativeEvent.data === 'EXIT_APP') {
            BackHandler.exitApp();
          }
        }}
        onCloseWindow={() => {
          BackHandler.exitApp();
        }}
        onError={({nativeEvent: {code, url, description}}: WebViewErrorEvent) => {
          console.error(`[onError]: (${code}: ${url}) ${description}`);
        }}
        onHttpError={({
          nativeEvent: {url, statusCode: code, description, isMainFrame},
        }: WebViewHttpErrorEvent) => {
          console.error(`[onHttpError]: (${code}: ${url}) ${description} mainFrame=${isMainFrame}`);
        }}
        onSslError={({code, url, description}: SslErrorData) => {
          console.error(`[onSslError]: (${code}: ${url}) ${description}`);
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1},
  webview: {backgroundColor: '#000000'},
});
