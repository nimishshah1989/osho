// PM2 process definition for the Next.js frontend.
//
// Started by deploy/iceland/02-setup-frontend.sh with:
//   pm2 startOrReload ecosystem.config.js
//
// Logs go to ~/.pm2/logs/osho-frontend-*.log.

module.exports = {
  apps: [
    {
      name: 'osho-frontend',
      cwd: '/home/osho/osho/frontend',
      script: 'npm',
      args: 'run start',
      // Listen on 127.0.0.1:3000 — nginx fronts us
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOSTNAME: '127.0.0.1',
      },
      // Restart if RSS exceeds 512MB (Next.js leaks slowly on long uptime)
      max_memory_restart: '512M',
      // Auto-restart on crash
      autorestart: true,
      // Don't watch — pm2 reload is the deploy mechanism
      watch: false,
      // Wait up to 10s for graceful shutdown
      kill_timeout: 10000,
    },
  ],
};
