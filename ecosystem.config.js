module.exports = {
  apps: [
    {
      name: "absensi-bot",
      script: "./index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      max_memory_restart: "1G",
      node_args: "--max-old-space-size=768",
      env: {
        NODE_ENV: "production",
        FACE_WORKER_COUNT: "2",
        FACE_QUEUE_LIMIT: "100",
        FACE_TIMEOUT_MS: "60000",
        NOTIFICATION_CONCURRENCY: "2",
        NOTIFICATION_QUEUE_LIMIT: "200",
        LID_LOOKUP_TIMEOUT_MS: "1500",
      },
    },
  ],
};
