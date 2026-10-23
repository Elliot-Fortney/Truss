import type { Overlay } from '../overlay.ts';
import apiGatewayRestApi from './apigateway-rest-api.ts';
import apiGatewayV2HttpApi from './apigatewayv2-http-api.ts';
import cloudFrontDistribution from './cloudfront-distribution.ts';
import dynamoDbTable from './dynamodb-table.ts';
import ec2Vpc from './ec2-vpc.ts';
import albFargateService from './ecs-patterns-alb-fargate-service.ts';
import eventsRule from './events-rule.ts';
import kinesisStream from './kinesis-stream.ts';
import lambdaFunction from './lambda-function.ts';
import rdsDatabaseInstance from './rds-database-instance.ts';
import s3Bucket from './s3-bucket.ts';
import secretsManagerSecret from './secretsmanager-secret.ts';
import snsTopic from './sns-topic.ts';
import sqsQueue from './sqs-queue.ts';
import stateMachine from './stepfunctions-state-machine.ts';

/**
 * Every Overlay Truss ships: one file per construct, written against the CI baseline `aws-cdk-lib`.
 * To add one, write the file next to these and list it here.
 */
export const OVERLAYS: readonly Overlay[] = [
  s3Bucket,
  lambdaFunction,
  dynamoDbTable,
  sqsQueue,
  snsTopic,
  apiGatewayRestApi,
  apiGatewayV2HttpApi,
  ec2Vpc,
  albFargateService,
  eventsRule,
  stateMachine,
  secretsManagerSecret,
  rdsDatabaseInstance,
  cloudFrontDistribution,
  kinesisStream,
];
