import * as cdk from 'aws-cdk-lib';
import { ShopStack } from '../lib/shop-stack';

const app = new cdk.App();
new ShopStack(app, 'ShopStack', {
  env: { account: '123456789012', region: 'us-east-1' },
});
