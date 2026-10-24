import * as cdk from 'aws-cdk-lib';
import { RefStack } from '../lib/ref-stack';

const app = new cdk.App();
new RefStack(app, 'Refs');
