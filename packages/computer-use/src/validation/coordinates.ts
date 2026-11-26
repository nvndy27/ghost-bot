import {
  ComputerUseError,
  type CaptureRegion,
  type CoordinateSpace,
  type DisplayGeometry,
  type ScreenshotMetadata,
} from '../contracts/types.ts'

export const MIN_SCALE_FACTOR = 0.25
export const MAX_SCALE_FACTOR = 8.0
export const MAX_CAPTURE_PIXELS = 33_177_600 // 8K UHD max

export function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ComputerUseError('INVALID_COORDINATES', `${label} must be a finite number`)
  }
  return value
}

export function validateDisplayGeometry(display: DisplayGeometry): DisplayGeometry {
  if (!display || typeof display !== 'object' || !display.displayId.trim()) {
    throw new ComputerUseError('INVALID_DISPLAY', 'Display geometry must have a valid displayId')
  }
  assertFiniteNumber(display.originX, 'display.originX')
  assertFiniteNumber(display.originY, 'display.originY')
  const logicalWidth = assertFiniteNumber(display.logicalWidth, 'display.logicalWidth')
  const logicalHeight = assertFiniteNumber(display.logicalHeight, 'display.logicalHeight')
  const physicalWidth = assertFiniteNumber(display.physicalWidth, 'display.physicalWidth')
  const physicalHeight = assertFiniteNumber(display.physicalHeight, 'display.physicalHeight')
  const scaleFactor = assertFiniteNumber(display.scaleFactor, 'display.scaleFactor')

  if (logicalWidth <= 0 || logicalHeight <= 0 || physicalWidth <= 0 || physicalHeight <= 0) {
    throw new ComputerUseError('INVALID_DISPLAY', `Display "${display.displayId}" dimensions must be positive`)
  }
  if (scaleFactor < MIN_SCALE_FACTOR || scaleFactor > MAX_SCALE_FACTOR) {
    throw new ComputerUseError(
      'INVALID_DISPLAY',
      `Display "${display.displayId}" scaleFactor ${scaleFactor} must be ${MIN_SCALE_FACTOR}..${MAX_SCALE_FACTOR}`,
    )
  }
  if (!Number.isInteger(display.topologyVersion) || display.topologyVersion < 1) {
    throw new ComputerUseError('INVALID_DISPLAY', `Display "${display.displayId}" topologyVersion must be >= 1`)
  }
  return display
}

export function logicalToPhysical(
  display: DisplayGeometry,
  logicalX: number,
  logicalY: number,
): { x: number; y: number } {
  validateDisplayGeometry(display)
  const lx = assertFiniteNumber(logicalX, 'logicalX')
  const ly = assertFiniteNumber(logicalY, 'logicalY')
  return {
    x: Math.round(lx * display.scaleFactor),
    y: Math.round(ly * display.scaleFactor),
  }
}

export function physicalToLogical(
  display: DisplayGeometry,
  physicalX: number,
  physicalY: number,
): { x: number; y: number } {
  validateDisplayGeometry(display)
  const px = assertFiniteNumber(physicalX, 'physicalX')
  const py = assertFiniteNumber(physicalY, 'physicalY')
  return {
    x: px / display.scaleFactor,
    y: py / display.scaleFactor,
  }
}

export function validateCaptureRegion(
  display: DisplayGeometry,
  region: CaptureRegion,
): CaptureRegion {
  validateDisplayGeometry(display)
  if (region.displayId !== display.displayId) {
    throw new ComputerUseError(
      'INVALID_DISPLAY',
      `Capture region displayId "${region.displayId}" does not match target display "${display.displayId}"`,
    )
  }
  const x = assertFiniteNumber(region.x, 'region.x')
  const y = assertFiniteNumber(region.y, 'region.y')
  const width = assertFiniteNumber(region.width, 'region.width')
  const height = assertFiniteNumber(region.height, 'region.height')

  if (width <= 0 || height <= 0) {
    throw new ComputerUseError('INVALID_COORDINATES', 'Capture region width and height must be positive')
  }

  const maxW = region.coordinateSpace === 'logical' ? display.logicalWidth : display.physicalWidth
  const maxH = region.coordinateSpace === 'logical' ? display.logicalHeight : display.physicalHeight

  if (x < 0 || y < 0 || x + width > maxW || y + height > maxH) {
    throw new ComputerUseError(
      'INVALID_COORDINATES',
      `Capture region (${x},${y},${width}x${height}) exceeds ${region.coordinateSpace} bounds (${maxW}x${maxH})`,
    )
  }

  const physW = region.coordinateSpace === 'logical' ? width * display.scaleFactor : width
  const physH = region.coordinateSpace === 'logical' ? height * display.scaleFactor : height
  if (physW * physH > MAX_CAPTURE_PIXELS) {
    throw new ComputerUseError('INVALID_COORDINATES', 'Capture region exceeds maximum allowed pixel area')
  }

  return region
}

export function validatePointerTarget(
  displays: DisplayGeometry[],
  target: {
    displayId: string
    x: number
    y: number
    coordinateSpace: CoordinateSpace
    observation?: ScreenshotMetadata
    expectedTopologyVersion?: number
  },
): { display: DisplayGeometry; logicalX: number; logicalY: number; physicalX: number; physicalY: number } {
  const display = displays.find((d) => d.displayId === target.displayId)
  if (!display) {
    throw new ComputerUseError('INVALID_DISPLAY', `Unknown displayId "${target.displayId}"`)
  }
  validateDisplayGeometry(display)

  if (
    target.expectedTopologyVersion !== undefined &&
    target.expectedTopologyVersion !== display.topologyVersion
  ) {
    throw new ComputerUseError(
      'STALE_OBSERVATION',
      `Action topologyVersion ${target.expectedTopologyVersion} is stale (current: ${display.topologyVersion})`,
    )
  }

  if (target.observation) {
    if (target.observation.displayId !== display.displayId) {
      throw new ComputerUseError(
        'STALE_OBSERVATION',
        `Observation displayId "${target.observation.displayId}" does not match action displayId "${display.displayId}"`,
      )
    }
    if (target.observation.topologyVersion !== display.topologyVersion) {
      throw new ComputerUseError(
        'STALE_OBSERVATION',
        `Observation topologyVersion ${target.observation.topologyVersion} is stale (current: ${display.topologyVersion})`,
      )
    }
    if (
      target.observation.logicalWidth !== display.logicalWidth ||
      target.observation.logicalHeight !== display.logicalHeight
    ) {
      throw new ComputerUseError(
        'STALE_OBSERVATION',
        'Observation dimensions no longer match current display geometry',
      )
    }
  }

  const x = assertFiniteNumber(target.x, 'x')
  const y = assertFiniteNumber(target.y, 'y')
  const maxW = target.coordinateSpace === 'logical' ? display.logicalWidth : display.physicalWidth
  const maxH = target.coordinateSpace === 'logical' ? display.logicalHeight : display.physicalHeight

  if (x < 0 || y < 0 || x >= maxW || y >= maxH) {
    throw new ComputerUseError(
      'INVALID_COORDINATES',
      `Pointer target (${x}, ${y}) is outside ${target.coordinateSpace} display bounds (${maxW}x${maxH})`,
    )
  }

  if (target.coordinateSpace === 'logical') {
    const phys = logicalToPhysical(display, x, y)
    return { display, logicalX: x, logicalY: y, physicalX: phys.x, physicalY: phys.y }
  }

  const log = physicalToLogical(display, x, y)
  return { display, logicalX: log.x, logicalY: log.y, physicalX: x, physicalY: y }
}
