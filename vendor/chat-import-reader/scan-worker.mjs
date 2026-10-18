import { scanConversations } from './scanners.mjs'

process.on('message', async ({ id, input }) => {
  try { process.send?.({ id, result: await scanConversations(input) }) }
  catch (error) { process.send?.({ id, error: error.message || String(error) }) }
})
process.on('disconnect', () => process.exit())
