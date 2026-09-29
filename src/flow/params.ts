// Tuning for the wind-particle layer. Pure numbers, no three.

/**
 * Visual time scale: particles are advected by `wind * VISUAL_TIME_SCALE` per real second.
 * Real wind is slow against a multi-km volume (10 m/s ≈ 1 px/frame at 2 km), so without it the air
 * looks frozen. A single linear factor keeps direction and speed ratios truthful: a 60 m/s jet still
 * draws trails 7.5× longer than 8 m/s background flow. Trail length on screen ≈ speed × SCALE × TRAIL_S.
 */
export const VISUAL_TIME_SCALE = 10

/** Ring buffer depth (points per trail) and real seconds between two recorded points. */
export const TRAIL_POINTS = 32
export const PUSH_DT = 0.15
/** = TRAIL_POINTS * PUSH_DT: how long (real s) a trail remembers. */
export const TRAIL_S = TRAIL_POINTS * PUSH_DT

export const DEFAULT_PARTICLES = 3000

/** Spawn volume: a sphere around the camera plus the view frustum out to FAR. */
export const NEAR_RADIUS = 1500
export const FAR_DISTANCE = 9000
/** Share of spawns placed in the view frustum (the rest fill the near sphere, for fast turns). */
export const FRUSTUM_SHARE = 0.72
/** Frustum spawn depth bias exponent (>1 = denser near the camera). */
export const DEPTH_BIAS = 1.3
/** Frustum spawns slightly overshoot the screen edges so particles drift in rather than pop. */
export const FRUSTUM_MARGIN = 1.15

/**
 * Importance spawning: a candidate in plain background flow is kept with this probability, else
 * re-drawn (up to SPAWN_TRIES). Concentrates particles where the air does something worth reading.
 */
export const CALM_ACCEPT = 0.3
export const SPAWN_TRIES = 4
/** |vertical wind| (m/s) above which background air counts as interesting anyway. */
export const INTERESTING_W = 2.5

/** Real-second lifetime range. */
export const LIFE_MIN = 5
export const LIFE_MAX = 10

/** Weather is sampled for 1 particle in `stride` each frame; velocities are held in between. */
export const DEFAULT_SAMPLE_STRIDE = 2
export const MAX_SAMPLE_STRIDE = 6
/** CPU budget for update(); the layer raises the stride when above it. */
export const CPU_BUDGET_MS = 2.5

/** Camera jump (m in one update) that invalidates every particle. */
export const TELEPORT_DISTANCE = 2000

/** Dominant feature → integer code written into the GPU buffer (shader switches on it). */
export const KIND_CODE = {
  none: 0,
  updraft: 1,
  downdraft: 2,
  thermal: 3,
  jetstream: 4,
  shear: 5,
  wake: 6,
  storm: 7,
} as const
