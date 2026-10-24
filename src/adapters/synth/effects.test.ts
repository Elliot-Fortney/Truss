import { describe, expect, it } from 'vitest';
import { templateEffects, type EffectTemplate } from './effects.ts';

const res = (path: string, Type: string, Properties: Record<string, unknown> = {}) => ({
  Type,
  Metadata: { 'aws:cdk:path': path },
  Properties,
});
const policy = (statement: Record<string, unknown>, roles: unknown[] = [{ Ref: 'FnRole' }]) =>
  res('S/Fn/ServiceRole/DefaultPolicy/Resource', 'AWS::IAM::Policy', {
    Roles: roles,
    PolicyDocument: { Statement: [statement], Version: '2012-10-17' },
  });

const base: EffectTemplate['Resources'] = {
  FnRole: res('S/Fn/ServiceRole/Resource', 'AWS::IAM::Role'),
  Bucket: res('S/Bucket/Resource', 'AWS::S3::Bucket'),
  Queue: res('S/Queue/Resource', 'AWS::SQS::Queue'),
};

describe('templateEffects', () => {
  it('reads each allowed resource of a policy as a grant from the roles it is attached to', () => {
    const { effects } = templateEffects([
      {
        Resources: {
          ...base,
          Pol: policy({
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:List*'],
            Resource: [
              { 'Fn::GetAtt': ['Bucket', 'Arn'] },
              { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }, '/*']] },
              '*',
            ],
          }),
        },
      },
    ]);
    const source = { paths: ['S/Fn/ServiceRole/Resource'], text: '{S/Fn/ServiceRole/Resource}' };
    expect(effects.map((e) => ({ ...e, at: undefined }))).toEqual(
      [
        {
          kind: 'grant',
          source,
          target: { paths: ['S/Bucket/Resource'], text: '{S/Bucket/Resource}' },
          detail: 's3:GetObject, s3:List*',
        },
        {
          kind: 'grant',
          source,
          target: { paths: ['S/Bucket/Resource'], text: '{S/Bucket/Resource}/*' },
          detail: 's3:GetObject, s3:List*',
        },
        { kind: 'grant', source, target: { paths: [], text: '*' }, detail: 's3:GetObject, s3:List*' },
      ].map((e) => ({ ...e, at: undefined })),
    );
    expect(effects[0]!.at).toBe('S/Fn/ServiceRole/DefaultPolicy/Resource');
  });

  it('keeps a raw ARN as text, spelling the partition out', () => {
    const { effects } = templateEffects([
      {
        Resources: {
          ...base,
          Pol: policy({
            Effect: 'Allow',
            Action: 's3:*',
            Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':s3:::existing']] },
          }),
        },
      },
    ]);
    expect(effects[0]!.target).toEqual({ paths: [], text: 'arn:aws:s3:::existing' });
  });

  it('skips Deny statements', () => {
    const { effects } = templateEffects([
      { Resources: { ...base, Pol: policy({ Effect: 'Deny', Action: 's3:*', Resource: '*' }) } },
    ]);
    expect(effects).toEqual([]);
  });

  it('reads a role inline policy as a grant from the role itself', () => {
    const { effects } = templateEffects([
      {
        Resources: {
          Role: res('S/Role/Resource', 'AWS::IAM::Role', {
            Policies: [
              {
                PolicyDocument: {
                  Statement: [{ Effect: 'Allow', Action: 'sqs:*', Resource: { 'Fn::GetAtt': ['Queue', 'Arn'] } }],
                },
              },
            ],
          }),
          Queue: base.Queue!,
        },
      },
    ]);
    expect(effects).toMatchObject([
      {
        kind: 'grant',
        at: 'S/Role/Resource',
        source: { paths: ['S/Role/Resource'] },
        target: { paths: ['S/Queue/Resource'] },
      },
    ]);
  });

  it('attaches a managed policy to the roles that list it', () => {
    const { effects } = templateEffects([
      {
        Resources: {
          Role: res('S/Role/Resource', 'AWS::IAM::Role', { ManagedPolicyArns: [{ Ref: 'Managed' }] }),
          Managed: res('S/Managed/Resource', 'AWS::IAM::ManagedPolicy', {
            PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'x:y', Resource: '*' }] },
          }),
        },
      },
    ]);
    expect(effects[0]!.source.paths).toEqual(['S/Role/Resource']);
  });

  it('reads event source mappings, subscriptions and rule targets as integrations', () => {
    const { effects } = templateEffects([
      {
        Resources: {
          ...base,
          Fn: res('S/Fn/Resource', 'AWS::Lambda::Function'),
          Topic: res('S/Topic/Resource', 'AWS::SNS::Topic'),
          Map: res('S/Fn/SqsEventSource/Resource', 'AWS::Lambda::EventSourceMapping', {
            EventSourceArn: { 'Fn::GetAtt': ['Queue', 'Arn'] },
            FunctionName: { Ref: 'Fn' },
          }),
          Sub: res('S/Topic/Sub/Resource', 'AWS::SNS::Subscription', {
            TopicArn: { Ref: 'Topic' },
            Protocol: 'lambda',
            Endpoint: { 'Fn::GetAtt': ['Fn', 'Arn'] },
          }),
          Rule: res('S/Rule/Resource', 'AWS::Events::Rule', {
            Targets: [
              { Arn: { 'Fn::GetAtt': ['Fn', 'Arn'] }, Id: 'T' },
              { Arn: 'arn:aws:sqs:::elsewhere', Id: 'U' },
            ],
          }),
        },
      },
    ]);
    expect(effects.map((e) => [e.kind, e.source.paths, e.target.paths, e.detail])).toEqual([
      ['integration', ['S/Queue/Resource'], ['S/Fn/Resource'], 'event source mapping'],
      ['integration', ['S/Topic/Resource'], ['S/Fn/Resource'], 'subscription (lambda)'],
      ['integration', ['S/Rule/Resource'], ['S/Fn/Resource'], 'rule target'],
      ['integration', ['S/Rule/Resource'], [], 'rule target'],
    ]);
  });

  it('reads security group rules as network effects, leaving out the default egress', () => {
    const { effects } = templateEffects([
      {
        Resources: {
          A: res('S/A/Resource', 'AWS::EC2::SecurityGroup', {
            SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', IpProtocol: '-1' }],
          }),
          B: res('S/B/Resource', 'AWS::EC2::SecurityGroup', {
            SecurityGroupIngress: [{ CidrIp: '10.0.0.0/8', IpProtocol: 'tcp', FromPort: 22, ToPort: 22 }],
          }),
          Ing: res('S/B/from A/Resource', 'AWS::EC2::SecurityGroupIngress', {
            GroupId: { 'Fn::GetAtt': ['B', 'GroupId'] },
            SourceSecurityGroupId: { 'Fn::GetAtt': ['A', 'GroupId'] },
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
          }),
          Egr: res('S/A/to B/Resource', 'AWS::EC2::SecurityGroupEgress', {
            GroupId: { 'Fn::GetAtt': ['A', 'GroupId'] },
            DestinationSecurityGroupId: { 'Fn::GetAtt': ['B', 'GroupId'] },
            IpProtocol: 'tcp',
            FromPort: 1,
            ToPort: 9,
          }),
        },
      },
    ]);
    expect(effects.map((e) => [e.kind, e.source.paths, e.source.text, e.target.paths, e.detail])).toEqual([
      ['network', [], '10.0.0.0/8', ['S/B/Resource'], 'tcp 22'],
      ['network', ['S/A/Resource'], '{S/A/Resource}', ['S/B/Resource'], 'tcp 5432'],
      ['network', ['S/A/Resource'], '{S/A/Resource}', ['S/B/Resource'], 'tcp 1-9'],
    ]);
  });

  it('pairs Fn::ImportValue with its Export across templates', () => {
    const producer: EffectTemplate = {
      Resources: { Queue: res('A/Queue/Resource', 'AWS::SQS::Queue') },
      Outputs: { Out: { Value: { 'Fn::GetAtt': ['Queue', 'Arn'] }, Export: { Name: 'A:ExportsOutputQueueArn' } } },
    };
    const consumer: EffectTemplate = {
      Resources: {
        Fn: res('B/Fn/Resource', 'AWS::Lambda::Function', {
          Environment: { Variables: { Q: { 'Fn::ImportValue': 'A:ExportsOutputQueueArn' } } },
        }),
        Role: res('B/Fn/ServiceRole/Resource', 'AWS::IAM::Role'),
        Pol: res('B/Fn/ServiceRole/DefaultPolicy/Resource', 'AWS::IAM::Policy', {
          Roles: [{ Ref: 'Role' }],
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: 'sqs:SendMessage',
                Resource: { 'Fn::ImportValue': 'A:ExportsOutputQueueArn' },
              },
            ],
          },
        }),
      },
    };
    const { effects, importRefs } = templateEffects([producer, consumer]);
    expect(importRefs).toEqual([{ from: 'B/Fn/Resource', to: 'A/Queue/Resource', prop: 'Environment' }]);
    expect(effects[0]!.target.paths).toEqual(['A/Queue/Resource']);
  });
});
