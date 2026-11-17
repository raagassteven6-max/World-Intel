// markers.js — draws the little map icons on a canvas (no image files to host or load).
// Each entity type has its own SHAPE, so you can tell types apart without relying on colour.
// Simulated markers get a dashed ring; real data will (later) get a solid look.

import { TYPE_STYLE } from './config.js';

const cache = new Map();
const S = 64; // canvas size; shapes are designed on a 64×64 grid

function shape(ctx, type) {
  switch (type) {
    case 'aircraft':   // arrow-head with swept wings, nose up
      ctx.moveTo(32, 5); ctx.lineTo(43, 52); ctx.lineTo(32, 44); ctx.lineTo(21, 52); ctx.closePath(); break;
    case 'ship':       // pointed hull, bow up
      ctx.moveTo(32, 6); ctx.lineTo(44, 24); ctx.lineTo(41, 56); ctx.lineTo(23, 56); ctx.lineTo(20, 24); ctx.closePath(); break;
    case 'satellite':  // body + two panels
      ctx.rect(25, 25, 14, 14); ctx.rect(6, 28, 15, 8); ctx.rect(43, 28, 15, 8); break;
    case 'earthquake': // epicentre + ring
      ctx.arc(32, 32, 9, 0, Math.PI * 2); ctx.moveTo(52, 32); ctx.arc(32, 32, 20, 0, Math.PI * 2); break;
    case 'wildfire':   // teardrop flame
      ctx.moveTo(32, 5); ctx.bezierCurveTo(54, 27, 51, 52, 32, 58); ctx.bezierCurveTo(13, 52, 10, 27, 32, 5); ctx.closePath(); break;
    case 'weather':    // hexagon
      for (let i = 0; i < 6; i += 1) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const x = 32 + 24 * Math.cos(a); const y = 32 + 24 * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); break;
    case 'location':   // diamond
      ctx.moveTo(32, 6); ctx.lineTo(56, 32); ctx.lineTo(32, 58); ctx.lineTo(8, 32); ctx.closePath(); break;
    case 'camera':     // rounded square
      ctx.roundRect(10, 14, 44, 36, 8); break;
    case 'pin':        // reticle ring
      ctx.arc(32, 32, 20, 0, Math.PI * 2); break;
    default:
      ctx.arc(32, 32, 16, 0, Math.PI * 2);
  }
}

/** Data-URL icon for a type. `sim: true` adds the dashed "this is simulated" ring. */
export function markerIcon(type, { sim = false } = {}) {
  const key = `${type}|${sim}`;
  if (cache.has(key)) return cache.get(key);
  const color = (TYPE_STYLE[type] ?? TYPE_STYLE.pin).color;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.lineJoin = 'round';

  ctx.beginPath(); shape(ctx, type);
  ctx.lineWidth = 6; ctx.strokeStyle = '#05090f'; ctx.stroke();           // dark outline for contrast on any basemap
  ctx.fillStyle = type === 'pin' ? 'rgba(0,0,0,0)' : color; ctx.fill('evenodd');
  ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();

  if (type === 'pin') {                                                    // crosshair ticks
    ctx.beginPath();
    ctx.moveTo(32, 4); ctx.lineTo(32, 18); ctx.moveTo(32, 46); ctx.lineTo(32, 60);
    ctx.moveTo(4, 32); ctx.lineTo(18, 32); ctx.moveTo(46, 32); ctx.lineTo(60, 32);
    ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke();
  }
  if (type === 'camera') {                                                  // lens
    ctx.beginPath(); ctx.arc(32, 32, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#05090f'; ctx.fill();
  }
  if (sim) {
    ctx.beginPath(); ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.setLineDash([5, 5]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(245,184,61,0.95)'; ctx.stroke();
    ctx.setLineDash([]);
  }
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

/** Round badge with a count, used when many markers collapse into one (clustering). */
export function clusterIcon(count) {
  const label = count > 99 ? '99+' : String(count);
  const key = `cluster|${label}`;
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2);
  ctx.fillStyle = '#0a111a'; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = '#38d6f5'; ctx.stroke();
  ctx.fillStyle = '#d6e4f0';
  ctx.font = `700 ${label.length > 2 ? 20 : 24}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, 32, 34);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
