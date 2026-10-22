export interface ReleaseFeature {
  title: string
  description: string
  media?: string
  alt?: string
  en?: { title: string; description: string; alt?: string }
}

declare const __REFERENCE_RELEASE_FEATURES__: Record<string, readonly ReleaseFeature[]>

export function releaseFeaturesFor(version: string, language = 'zh'): readonly ReleaseFeature[] {
  if (version === '0.5.1') version = '0.5.0'
  const cards = typeof __REFERENCE_RELEASE_FEATURES__ === 'undefined' ? [] : __REFERENCE_RELEASE_FEATURES__[version] ?? []
  return language.startsWith('zh') ? cards : cards.map(card => card.en ? { ...card, ...card.en } : card)
}
