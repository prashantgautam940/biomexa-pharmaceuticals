cat << 'EOF' > package.json
{
  "name": "biomexa-backend",
  "version": "1.0.0",
  "description": "Biomexa Pharmaceuticals - Medicine Reminder Backend",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.2",
    "mongoose": "^8.0.0",
    "node-cron": "^3.0.3",
    "twilio": "^4.19.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
EOF