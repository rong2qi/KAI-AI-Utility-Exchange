#!/usr/bin/env node

import { createMacKeychainApiKeyResolver } from '../src/adapters/xfyun-spark-provider.mjs';

try {
  const key = await createMacKeychainApiKeyResolver()();
  console.log(key ? 'keychain_status=available' : 'keychain_status=missing');
} catch {
  console.log('keychain_status=unavailable');
  process.exitCode = 1;
}
