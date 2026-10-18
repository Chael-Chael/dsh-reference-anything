export interface ReleaseFeature {
  title: string
  description: string
  media?: string
  alt?: string
}

declare const __REFERENCE_RELEASE_FEATURES__: Record<string, readonly ReleaseFeature[]>

export function releaseFeaturesFor(version: string): readonly ReleaseFeature[] {
  return typeof __REFERENCE_RELEASE_FEATURES__ === 'undefined' ? [] : __REFERENCE_RELEASE_FEATURES__[version] ?? []
}
