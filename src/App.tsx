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
// streaming server at config.baseUrl over HTTPS). It handles the remote Back
// key itself (listens for GoBack/Escape), so the only thing we inject is a
// tiny shim that also dispatches an Escape on GoBack, as a belt-and-braces for
// any <video> fullscreen/native overlay. Page-level history is driven by the
// RN BackHandler below.
const INIT_SCRIPT = `
(function () {
  if (window.__vegaInit) return;
  window.__vegaInit = true;
  document.addEventListener(
    'keydown',
    function (e) {
      if (e.key === 'GoBack' || e.keyCode === 27) {
        var esc = new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
          bubbles: true, cancelable: true,
        });
        document.dispatchEvent(esc);
      }
    },
    true,
  );
})();
true;
`;

export const App = () => {
  const webRef = useRef<WebViewMethods | null>(null);
  const canGoBackRef = useRef(false);
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  // Hardware Back: navigate WebView history when possible, else let the system
  // exit the app.
  useEffect(() => {
    const onBackPress = (): boolean => {
      if (canGoBackRef.current && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false;
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
