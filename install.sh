#!/bin/bash

echo "Installing PetLibro Homebridge Plugin..."

# Create plugin directory
sudo mkdir -p /var/lib/homebridge/node_modules/homebridge-petlibro

# Copy files (assuming they are in current directory)
sudo cp index.js /var/lib/homebridge/node_modules/homebridge-petlibro/
sudo cp package.json /var/lib/homebridge/node_modules/homebridge-petlibro/

# Install dependencies
cd /var/lib/homebridge/node_modules/homebridge-petlibro
sudo npm install axios

# Set proper permissions
sudo chown -R homebridge:homebridge /var/lib/homebridge/node_modules/homebridge-petlibro

echo "Plugin installed successfully!"
echo ""
echo "Now add this to your Homebridge config.json in the 'platforms' section:"
echo ""
echo '{'
echo '  "platform": "PetLibroPlatform",'
echo '  "name": "Pet Feeder",'
echo '  "email": "your-petlibro-email@example.com",'
echo '  "password": "your-petlibro-password",'
echo '  "portions": 1,'
echo '  "timezone": "America/New_York"'
echo '}'
echo ""
echo "IMPORTANT: Before testing, please verify:"
echo "1. Your email/password work in the official PetLibro mobile app"
echo "2. You're using the correct PetLibro app (not PetLibro Lite)"
echo "3. Only one device can be logged in at a time"
echo ""
echo "Then restart Homebridge with: sudo systemctl restart homebridge"