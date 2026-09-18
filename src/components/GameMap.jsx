import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import * as turf from '@turf/turf';
import { circlePolygon, nearestPointOnCircle, outsideCircle } from '../lib/geo';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * Map with the game's layers. Everything is optional so the same component powers the player view,
 * gamemaker dashboard, spectator view, replay, and the creation editor.
 *
 * props:
 *  playArea     Polygon coordinates
 *  storm        result of stormAt()
 *  players      [{ id, name, color, lng, lat, isMe, dim, ring }]
 *  chests       [{ id, lng, lat, claimed }]
 *  me           { lng, lat } — draws the "head to safe zone" line when outside the target circle
 *  circles      [{ center, radius, color, label }] — extra outlines (used by the editor)
 *  onLoad(map)  access to the mapbox instance (editor markers)
 *  onPlayerClick(id)
 *  cooperativeGestures  two fingers to pan/zoom (for a map embedded in a scrolling page)
 *  hideLabels   hide player names and every place name on the map (for sharing a replay)
 */
export default function GameMap({ playArea, storm, players, chests, me, circles, onLoad, onPlayerClick, className, fitKey, cooperativeGestures, hideLabels }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);
  const chestMarkers = useRef({});
  const clickRef = useRef(onPlayerClick);

  useEffect(() => {
    clickRef.current = onPlayerClick;
  }, [onPlayerClick]);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-90.3075, 38.65],
      zoom: 14,
      attributionControl: false,
      pitchWithRotate: false,
      // On the player screen the map sits inside a scrolling page: one finger scrolls the page,
      // two fingers pan and zoom the map.
      cooperativeGestures,
    });
    map.addControl(new mapboxgl.AttributionControl({ compact: true }));
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    map.on('error', (e) => console.error('[map]', e.error?.message ?? e));

    map.on('load', () => {
      const add = (id) => map.addSource(id, { type: 'geojson', data: EMPTY });
      ['play-area', 'storm', 'storm-preview', 'target', 'guide', 'players', 'circles'].forEach(add);

      map.addLayer({ id: 'storm-preview', type: 'fill', source: 'storm-preview', paint: { 'fill-color': '#a855f7', 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'storm', type: 'fill', source: 'storm', paint: { 'fill-color': '#7c3aed', 'fill-opacity': 0.45 } });
      map.addLayer({ id: 'storm-edge', type: 'line', source: 'storm', paint: { 'line-color': '#c084fc', 'line-width': 3 } });
      map.addLayer({ id: 'play-area', type: 'line', source: 'play-area', paint: { 'line-color': '#111111', 'line-width': 2, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'target', type: 'line', source: 'target', paint: { 'line-color': '#111111', 'line-width': 3 } });
      map.addLayer({ id: 'circles', type: 'line', source: 'circles', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [3, 1.5] } });
      map.addLayer({ id: 'guide', type: 'line', source: 'guide', paint: { 'line-color': '#111111', 'line-width': 3, 'line-dasharray': [1, 1.5] } });
      map.addLayer({
        id: 'players-ring', type: 'circle', source: 'players',
        paint: {
          'circle-radius': ['case', ['get', 'isMe'], 14, 11],
          'circle-color': ['get', 'ring'],
          'circle-opacity': ['case', ['get', 'dim'], 0.3, 0.9],
        },
      });
      map.addLayer({
        id: 'players', type: 'circle', source: 'players',
        paint: {
          'circle-radius': ['case', ['get', 'isMe'], 9, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': ['case', ['get', 'dim'], 0.45, 1],
        },
      });
      map.addLayer({
        id: 'player-labels', type: 'symbol', source: 'players',
        layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': true },
        paint: { 'text-color': '#111111', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });
      map.on('click', 'players', (e) => clickRef.current?.(e.features[0]?.properties.id));
      setReady(true);
      onLoad?.(map);
    });

    const resize = new ResizeObserver(() => map.resize());
    resize.observe(containerRef.current);
    return () => {
      resize.disconnect();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit to the play area whenever fitKey changes (and on first load).
  useEffect(() => {
    if (!ready || !playArea) return;
    mapRef.current.fitBounds(turf.bbox(turf.polygon(playArea)), { padding: 30, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitKey]);

  useEffect(() => {
    if (!ready) return;
    mapRef.current.getSource('play-area').setData(playArea ? turf.polygon(playArea) : EMPTY);
  }, [ready, playArea]);

  // Every text layer, both Mapbox's street and place names and our own player labels.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    for (const layer of map.getStyle().layers) {
      if (layer.type === 'symbol') map.setLayoutProperty(layer.id, 'visibility', hideLabels ? 'none' : 'visible');
    }
  }, [ready, hideLabels]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const showStorm = storm?.active;
    map.getSource('storm').setData(showStorm ? outsideCircle(storm.center, storm.radius) : EMPTY);
    map.getSource('target').setData(storm?.target ? circlePolygon(storm.target.center, storm.target.radius) : EMPTY);
    map.getSource('storm-preview').setData(storm?.target ? outsideCircle(storm.target.center, storm.target.radius) : EMPTY);

    const goal = storm?.target ?? (storm ? { center: storm.center, radius: storm.radius } : null);
    const outside = goal && me && turf.distance(goal.center, [me.lng, me.lat], { units: 'meters' }) > goal.radius;
    map.getSource('guide').setData(outside
      ? turf.lineString([[me.lng, me.lat], nearestPointOnCircle(goal.center, goal.radius, [me.lng, me.lat])])
      : EMPTY);
  }, [ready, storm, me]);

  useEffect(() => {
    if (!ready) return;
    mapRef.current.getSource('players').setData(turf.featureCollection((players ?? [])
      .filter((p) => p.lng != null)
      .map((p) => turf.point([p.lng, p.lat], {
        id: p.id, name: p.name, color: p.color ?? '#94a3b8', ring: p.ring ?? (p.isMe ? '#38bdf8' : 'rgba(0,0,0,0)'),
        isMe: !!p.isMe, dim: !!p.dim,
      }))));
  }, [ready, players]);

  useEffect(() => {
    if (!ready) return;
    mapRef.current.getSource('circles').setData(turf.featureCollection((circles ?? [])
      .map((c) => ({ ...circlePolygon(c.center, c.radius), properties: { color: c.color ?? '#fbbf24' } }))));
  }, [ready, circles]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const seen = new Set();
    for (const chest of chests ?? []) {
      seen.add(chest.id);
      let marker = chestMarkers.current[chest.id];
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'chest-marker';
        el.textContent = '🎁';
        marker = new mapboxgl.Marker({ element: el }).setLngLat([chest.lng, chest.lat]).addTo(map);
        chestMarkers.current[chest.id] = marker;
      }
      marker.setLngLat([chest.lng, chest.lat]);
      marker.getElement().classList.toggle('claimed', !!chest.claimed);
    }
    for (const [id, marker] of Object.entries(chestMarkers.current)) {
      if (!seen.has(id)) {
        marker.remove();
        delete chestMarkers.current[id];
      }
    }
  }, [ready, chests]);

  return <div ref={containerRef} className={`game-map ${className ?? ''}`} />;
}
