// PM2 — dois processos: API (HTTP + SSE) e worker (fila de jobs, automações, agendador)
module.exports = {
  apps: [
    {
      name: 'crm-api',
      cwd: require('path').join(__dirname, 'server'),
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', TZ: 'America/Sao_Paulo', RUN_WORKER_IN_PROCESS: 'false' },
      max_memory_restart: '700M',
      kill_timeout: 10000,
      time: true,
    },
    {
      name: 'crm-worker',
      cwd: require('path').join(__dirname, 'server'),
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', TZ: 'America/Sao_Paulo' },
      max_memory_restart: '500M',
      kill_timeout: 15000,
      time: true,
    },
  ],
};
