import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { handleApiRequest } from './server/api-handler'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    server: {
      host: true,
    },
    plugins: [
      react(),
      {
        name: 'nfl-data-api',
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (!(await handleApiRequest(request, response, env))) next()
          })
        },
      },
    ],
  }
})
