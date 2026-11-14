// OpenCLI discovery marker: registerProvider performs the cli() calls.
import { domFallbackScript, registerProvider } from './common.js'
import { historyScript, detailScript, whoamiScript } from './deepseek-scripts.js'
export { detailScript, whoamiScript } from './deepseek-scripts.js'

registerProvider({
  site: 'dsh-deepseek', provider: 'DeepSeek', domain: 'chat.deepseek.com',
  home: 'https://chat.deepseek.com/', conversationUrl: id => `https://chat.deepseek.com/a/chat/s/${encodeURIComponent(id)}`,
  whoamiScript,
  historyScript, detailScript, fallbackScript: domFallbackScript,
})
