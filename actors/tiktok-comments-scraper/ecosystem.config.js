module.exports = {
  apps: [
    {
      name: 'tiktok-local-signer',
      script: 'npm start',
      cwd: '/home/myuser/signer',
      env: {
        PORT: 8080
      }
    },
    {
      name: 'tiktok-comments-crawler',
      script: 'dist/main.js',
      cwd: '/home/myuser',
      autorestart: false
    }
  ]
};