import { useCallback, useEffect, useRef, useState } from 'react';
import { functionsUrl, rpc, supabase } from './supabaseClient';

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isAndroid = () => /Android/.test(navigator.userAgent);

/** Where to find the screen-timeout setting, per platform. */
export const screenTimeoutHint = () => (isIOS()
  ? 'Settings → Display & Brightness → Auto-Lock → Never'
  : isAndroid()
    ? 'Settings → Display → Screen timeout → longest option'
    : 'your phone\'s screen timeout setting');

/**
 * Chrome (Android, desktop) fires beforeinstallprompt, so installing is one tap.
 * Safari has no such API, so iPhone users get written steps instead.
 */
export function useInstallPrompt() {
  const [prompt, setPrompt] = useState(null);
  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setPrompt(() => e);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const onInstalled = () => setPrompt(null);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!prompt) return false;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') setPrompt(null);
    return outcome === 'accepted';
  }, [prompt]);

  return [!!prompt, install];
}

/**
 * Keeps the screen awake (Screen Wake Lock API). The lock is dropped by the OS whenever the page is hidden,
 * so it is re-requested each time the app comes back to the foreground.
 */
export function useWakeLock(enabled) {
  const [status, setStatus] = useState('off'); // off | on | failed
  const lockRef = useRef(null);
  const supported = 'wakeLock' in navigator;

  useEffect(() => {
    if (!enabled || !supported) return;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || lockRef.current) return;
      try {
        lockRef.current = await navigator.wakeLock.request('screen');
        if (cancelled) return lockRef.current.release();
        setStatus('on');
        lockRef.current.addEventListener('release', () => {
          lockRef.current = null;
          if (!cancelled) setStatus('off');
        });
      } catch {
        setStatus('failed');
      }
    };
    acquire();
    const onVisible = () => acquire();
    document.addEventListener('visibilitychange', onVisible);
    // Some browsers only grant the lock after a user gesture.
    document.addEventListener('touchend', onVisible, { passive: true });
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('touchend', onVisible);
      lockRef.current?.release();
      lockRef.current = null;
    };
  }, [enabled, supported]);

  return supported ? status : 'unsupported';
}

/**
 * Watches GPS and sends the latest fix to the server every `intervalSec` (also acting as a heartbeat,
 * so standing still doesn't look like going dark).
 */
export function useLocationReporter({ gameId, enabled, intervalSec = 3 }) {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const [lastSent, setLastSent] = useState(null);
  const latest = useRef(null);
  const hasGps = !!navigator.geolocation;

  useEffect(() => {
    if (!enabled || !gameId || !hasGps) return;
    let watchId = null;
    const startWatch = () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const fix = { lng: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy, at: Date.now() };
          latest.current = fix;
          setPosition(fix);
          setError(null);
        },
        (err) => setError(err.code === 1 ? 'Location permission is off. Turn it back on for this site in your browser settings.' : err.message),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
      );
    };
    startWatch();

    let sending = false;
    const send = async () => {
      const fix = latest.current;
      if (!fix || sending) return;
      sending = true;
      try {
        await rpc('report_location', { p_game: gameId, p_lng: fix.lng, p_lat: fix.lat, p_accuracy: fix.accuracy });
        setLastSent(Date.now());
      } catch (e) {
        setError(`Couldn't send location: ${e.message}`);
      } finally {
        sending = false;
      }
    };
    const timer = setInterval(send, intervalSec * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        startWatch();
        send();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, [gameId, enabled, intervalSec, hasGps]);

  return { position, error: hasGps ? error : 'This browser has no GPS access.', lastSent };
}

export function useGeolocationPermission() {
  const [state, setState] = useState('unknown');
  useEffect(() => {
    navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
      setState(p.state);
      p.onchange = () => setState(p.state);
    }).catch(() => {});
  }, []);
  const request = useCallback(() => new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => { setState('granted'); resolve(true); },
      () => { setState('denied'); resolve(false); },
      { enableHighAccuracy: true, timeout: 20000 },
    );
  }), []);
  return [state, request];
}

// ───────────── Push notifications ─────────────

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker failed', e));
  }
}

const urlBase64ToUint8Array = (base64) => {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Must be called from a tap (iOS requires a user gesture). */
export async function enablePush() {
  if (!pushSupported()) {
    throw new Error(isIOS() && !isStandalone()
      ? 'On iPhone, add this site to your Home Screen and open it from there to get notifications.'
      : 'This browser does not support push notifications.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed.');

  const registration = await navigator.serviceWorker.ready;
  let publicKey = (await supabase.rpc('get_vapid_public_key')).data;
  if (!publicKey) {
    const res = await fetch(`${functionsUrl}/push`);
    publicKey = (await res.json()).publicKey;
  }
  const subscription = (await registration.pushManager.getSubscription())
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  const json = subscription.toJSON();
  await rpc('save_push_subscription', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth });
  return true;
}

export function usePushStatus() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    navigator.serviceWorker.ready
      .then((r) => r.pushManager.getSubscription())
      .then(async (sub) => {
        if (!sub) return;
        // Re-save in case this device's account changed (e.g. after using a rejoin code).
        const json = sub.toJSON();
        await supabase.rpc('save_push_subscription', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth });
        setEnabled(true);
      })
      .catch(() => {});
  }, []);
  const enable = useCallback(async () => {
    await enablePush();
    setEnabled(true);
  }, []);
  return [enabled, enable];
}
