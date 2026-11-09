import { useEffect, useRef } from 'react';
import './atmosphere.css';

const colors = ['61, 216, 255', '185, 213, 255', '149, 112, 255', '235, 83, 220'];
const frameInterval = 1000 / 30;
const pixelBudget = 3_000_000;

export default function Atmosphere({ motion }: { motion: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const time = useRef(0);
  const pointer = useRef({ x: .5, y: .4, targetX: .5, targetY: .4 });
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d', { alpha: false });
    if (!element || !context) return;
    let width = 0, height = 0, frame = 0;
    let previous: number | null = null;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const moving = () => motion && !reducedMotion.matches && !document.hidden;
    const rgba = (color: string, opacity: number) => `rgba(${color},${opacity})`;
    const lights = colors.map((color, index) => {
      const light = document.createElement('canvas');
      light.width = 384;
      light.height = 384;
      const ctx = light.getContext('2d');
      if (ctx) {
        const glow = ctx.createRadialGradient(192, 192, 0, 192, 192, 192);
        const strength = index === 1 ? .12 : .22;
        glow.addColorStop(0, rgba(color, strength));
        glow.addColorStop(.4, rgba(color, strength * .42));
        glow.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, 384, 384);
      }
      return light;
    });

    function paint(timestamp: number) {
      frame = 0;
      if (document.hidden) return;
      const animated = moving();
      if (previous !== null && timestamp - previous < frameInterval && animated) { frame = requestAnimationFrame(paint); return; }
      const elapsed = previous === null ? 0 : Math.min(timestamp - previous, 80) / 1000;
      previous = timestamp;
      if (animated) {
        time.current += elapsed;
        const easing = 1 - Math.exp(-elapsed * 1.6);
        pointer.current.x += (pointer.current.targetX - pointer.current.x) * easing;
        pointer.current.y += (pointer.current.targetY - pointer.current.y) * easing;
      }
      const pointerX = pointer.current.x - .5;
      const pointerY = pointer.current.y - .4;
      const t = time.current;
      const ctx = context!;
      const base = ctx.createLinearGradient(0, 0, width * .8, height);
      base.addColorStop(0, '#080d17');
      base.addColorStop(.52, '#090c16');
      base.addColorStop(1, '#100b1b');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < lights.length; i++) {
        const phase = t * (.1 + i * .015) + i * 2.1;
        const x = width * ([.02, .48, .48, .96][i] + Math.sin(phase) * .095) + pointerX * 28;
        const y = height * ([.2, .12, .92, .62][i] + Math.cos(phase * .8) * .09) + pointerY * 22;
        const radius = Math.max(width * .45, height * .57) * (1 + Math.sin(phase * .7) * .04);
        ctx.drawImage(lights[i], x - radius, y - radius, radius * 2, radius * 2);
      }
      for (let i = 0; i < 3; i++) {
        const color = colors[[0, 2, 3][i]];
        const tint = colors[[1, 0, 2][i]];
        const phase = t * (.14 + i * .024) + i * 1.9;
        const y = height * (.25 + i * .34 + Math.sin(phase) * .09) + pointerY * 24;
        const lift = height * (.27 + Math.cos(phase * .73) * .08);
        const thickness = height * (.2 + Math.sin(phase + .9) * .04);
        const controlX = width * (.31 + Math.sin(phase * .81) * .1) + pointerX * 32;
        const farControlX = width * (.69 + Math.cos(phase * .62) * .07);
        const fold = height * (.22 + Math.sin(phase * .91 + .6) * .06);
        const fill = ctx.createLinearGradient(0, y + thickness, width, y - lift);
        fill.addColorStop(0, rgba(color, .02));
        fill.addColorStop(.24, rgba(tint, .21));
        fill.addColorStop(.48, 'rgba(174, 202, 243, .07)');
        fill.addColorStop(.62, rgba(color, .27));
        fill.addColorStop(.8, 'rgba(177, 207, 255, .12)');
        fill.addColorStop(1, rgba(color, .03));
        ctx.beginPath();
        ctx.moveTo(-width * .16, y + height * .19);
        ctx.bezierCurveTo(controlX, y - lift, farControlX, y + fold, width * 1.16, y - lift);
        ctx.bezierCurveTo(farControlX + width * .02, y + fold + thickness * .65, controlX + width * .08, y - lift + thickness, -width * .16, y + height * .19 + thickness);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        const edge = ctx.createLinearGradient(0, y, width, y - lift);
        edge.addColorStop(0, 'rgba(224, 231, 240, 0)');
        edge.addColorStop(.26, rgba(tint, .3));
        edge.addColorStop(.54 + Math.sin(phase * .7) * .08, 'rgba(224, 231, 240, .34)');
        edge.addColorStop(.82, rgba(color, .14));
        edge.addColorStop(1, 'rgba(224, 231, 240, 0)');
        ctx.beginPath();
        ctx.moveTo(-width * .16, y + height * .19);
        ctx.bezierCurveTo(controlX, y - lift, farControlX, y + fold, width * 1.16, y - lift);
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        const reflection = ctx.createLinearGradient(0, y + thickness, width, y - lift);
        reflection.addColorStop(0, rgba(color, 0));
        reflection.addColorStop(.38, rgba(color, .12));
        reflection.addColorStop(.68, 'rgba(212, 222, 234, .13)');
        reflection.addColorStop(1, rgba(color, 0));
        ctx.beginPath();
        ctx.moveTo(-width * .16, y + height * .19 + thickness);
        ctx.bezierCurveTo(controlX + width * .08, y - lift + thickness, farControlX + width * .02, y + fold + thickness * .65, width * 1.16, y - lift);
        ctx.strokeStyle = reflection;
        ctx.lineWidth = .8;
        ctx.stroke();
      }
      if (animated) frame = requestAnimationFrame(paint);
    }
    function redraw() {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = null;
      if (!document.hidden) frame = requestAnimationFrame(paint);
    }
    function resize() {
      width = Math.max(1, window.innerWidth); height = Math.max(1, window.innerHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(pixelBudget / (width * height)));
      element!.width = Math.max(1, Math.floor(width * ratio)); element!.height = Math.max(1, Math.floor(height * ratio));
      context!.setTransform(element!.width / width, 0, 0, element!.height / height, 0, 0);
      redraw();
    }
    function point(event: PointerEvent) {
      if (!moving() || event.pointerType === 'touch') return;
      pointer.current.targetX = Math.max(0, Math.min(1, event.clientX / width));
      pointer.current.targetY = Math.max(0, Math.min(1, event.clientY / height));
    }
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', point, { passive: true });
    document.addEventListener('visibilitychange', redraw);
    reducedMotion.addEventListener('change', redraw);
    resize();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', point);
      document.removeEventListener('visibilitychange', redraw);
      reducedMotion.removeEventListener('change', redraw);
    };
  }, [motion]);
  return <div className="atmosphere liquid-atmosphere atmosphere-aurora" aria-hidden="true"><canvas ref={canvas}/></div>;
}
