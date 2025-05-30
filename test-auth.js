#!/usr/bin/env node

const axios = require('axios');

// Test script to find the correct PetLibro API endpoint
const possibleEndpoints = [
  'https://iot.petlibro.com',
  'https://api.petlibro.com',
  'https://app.petlibro.com',
  'https://us.petlibro.com',
  'https://global.petlibro.com',
  'https://cloud.petlibro.com',
  'https://service.petlibro.com'
];

async function testEndpoint(baseUrl, email, password) {
  try {
    console.log(`Testing ${baseUrl}...`);
    
    const response = await axios.post(`${baseUrl}/v3/user/login`, {
      email: email,
      password: password,
      platform: 'ios'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PetLibro/1.0.0',
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    
    if (response.data && response.data.access_token) {
      console.log(`✅ SUCCESS: ${baseUrl} - Authentication successful!`);
      console.log(`Access token received: ${response.data.access_token.substring(0, 20)}...`);
      return baseUrl;
    }
  } catch (error) {
    if (error.code === 'ENOTFOUND') {
      console.log(`❌ ${baseUrl} - DNS resolution failed`);
    } else if (error.response && error.response.status === 401) {
      console.log(`🔑 ${baseUrl} - Endpoint exists but credentials invalid`);
    } else if (error.response && error.response.status === 404) {
      console.log(`❌ ${baseUrl} - Endpoint not found`);
    } else {
      console.log(`❌ ${baseUrl} - Error: ${error.message}`);
    }
  }
  return null;
}

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  
  if (!email || !password) {
    console.log('Usage: node test-auth.js your-email@example.com your-password');
    process.exit(1);
  }
  
  console.log('Testing PetLibro API endpoints...\n');
  
  let workingEndpoint = null;
  
  for (const endpoint of possibleEndpoints) {
    const result = await testEndpoint(endpoint, email, password);
    if (result) {
      workingEndpoint = result;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between tests
  }
  
  console.log('\n--- Results ---');
  if (workingEndpoint) {
    console.log(`Use this endpoint in your config: ${workingEndpoint}`);
  } else {
    console.log('No working endpoints found. Please check:');
    console.log('1. Your email and password are correct');
    console.log('2. Your internet connection');
    console.log('3. That you can login to the official PetLibro app');
  }
}

main().catch(console.error);