try {
  const get = async (path) => {
    const response = await fetch('http://127.0.0.1:11434' + path, {
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return response.json()
  }
  const { version } = await get('/api/version')
  const { models } = await get('/api/tags')
  if (typeof version !== 'string' || !Array.isArray(models)) throw new Error('Unexpected response')
  console.log(JSON.stringify({ version, installedModelCount: models.length }))
} catch {
  console.error('Ollama discovery failed at http://127.0.0.1:11434. Check the local service and API version.')
  process.exitCode = 1
}
