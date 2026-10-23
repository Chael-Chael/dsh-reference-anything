// OpenCLI discovery marker: registerProvider performs the cli() calls.
import { domFallbackScript, registerProvider } from './common.js'
import { historyScript, detailScript, whoamiScript } from './kimi-scripts.js'
export { detailScript, whoamiScript } from './kimi-scripts.js'

registerProvider({
  site: 'dsh-kimi', provider: 'Kimi', domain: 'kimi.com', home: 'https://www.kimi.com/',
  conversationUrl: id => `https://www.kimi.com/chat/${encodeURIComponent(id)}`,
  whoamiScript,
  historyScript, detailScript, fallbackScript: domFallbackScript,
})
