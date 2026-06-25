import type { SiteConfig, Regulations, Rect2D, Divider } from '@/types/planner'

export function getEnvelope(site: SiteConfig, regs: Regulations): Rect2D {
  return {
    x: regs.setbackSide,
    y: regs.setbackFront,
    w: Math.max(1, site.width  - regs.setbackSide * 2),
    h: Math.max(1, site.depth  - regs.setbackFront - regs.setbackRear),
  }
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

export function calcBCR(b: Rect2D, s: SiteConfig) {
  return (b.w * b.h) / (s.width * s.depth) * 100
}

export function calcFAR(b: Rect2D, s: SiteConfig, floors: number) {
  return (b.w * b.h * floors) / (s.width * s.depth) * 100
}

export function autoConfig(site: SiteConfig, regs: Regulations) {
  const env = getEnvelope(site, regs)
  const maxByBCR = site.width * site.depth * regs.bcrLimit / 100
  const maxByFAR = site.width * site.depth * regs.farLimit / 100 / Math.max(regs.floors, 1)
  const maxArea  = Math.min(maxByBCR, maxByFAR)
  const aspect   = env.w / Math.max(env.h, 0.1)
  const bw = clamp(Math.sqrt(maxArea * aspect), 5, env.w)
  const bh = clamp(maxArea / Math.max(bw, 0.1),  5, env.h)

  const building: Rect2D = {
    x: env.x + (env.w - bw) / 2,
    y: env.y + (env.h - bh) / 2,
    w: bw,
    h: bh,
  }

  const coreW = clamp(bw * 0.28, 5, 10)
  const coreH = clamp(bh * 0.15, 3,  6)
  const core: Rect2D = {
    x: building.x + (bw - coreW) / 2,
    y: building.y + (bh - coreH) / 2,
    w: coreW,
    h: coreH,
  }

  const unitWidth = 4.5
  const count = Math.max(1, Math.floor(bw / unitWidth))
  const dividers: Divider[] = []
  for (let i = 1; i < count; i++) {
    dividers.push({ id: `d${i}`, x: building.x + (bw / count) * i })
  }

  return { building, core, dividers }
}
