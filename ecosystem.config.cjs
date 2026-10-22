// PM2 process config for the aggregator
// Install: npm install -g pm2
// Start:   pm2 start ecosystem.config.cjs
// Monitor: pm2 monit
// Logs:    pm2 logs cellswap-aggregator

module.exports = {
  apps: [
    {
      name: 'cellswap-aggregator',
      script: './packages/aggregator/dist/main.js',
      instances: 1,          // single instance: pool cell contention rules out more than one
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,   // 5s between restarts
      max_restarts: 10,      // escalate if crashing repeatedly
      env: {
        NODE_ENV: 'production',
        NETWORK: 'testnet',
      },
      error_file: './logs/aggregator-error.log',
      out_file:   './logs/aggregator-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
}
