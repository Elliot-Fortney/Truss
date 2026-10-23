import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../core/catalog.ts';
import { hitDetail } from './palette.tsx';

const hit = (over: Partial<SearchHit>): SearchHit => ({ fqn: 'aws-cdk-lib.aws_s3.Bucket', name: 'Bucket', library: 'aws-cdk-lib', tier: 'L2', ...over });

describe('hitDetail', () => {
  it('names the service and the CloudFormation type', () => {
    expect(hitDetail(hit({ service: 'S3', cfnType: 'AWS::S3::Bucket' }))).toBe('S3 · AWS::S3::Bucket');
  });

  it('names the library when it is not aws-cdk-lib, so a third-party construct is not mistaken for a core one', () => {
    expect(hitDetail(hit({ library: '@aws-solutions-constructs/aws-lambda-dynamodb', name: 'LambdaToDynamoDB' }))).toBe('@aws-solutions-constructs/aws-lambda-dynamodb');
  });

  it('is empty for a construct with nothing to say', () => {
    expect(hitDetail(hit({}))).toBe('');
  });
});
