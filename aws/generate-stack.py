#!/usr/bin/env python3
"""Generate the isolated, reviewable Radar stack; performs no AWS calls."""
import json
from pathlib import Path

def ref(name):
    return {'Ref': name}

def sub(value):
    return {'Fn::Sub': value}

def arn(name):
    return {'Fn::GetAtt': [name, 'Arn']}

BOOTSTRAP = r'''#!/usr/bin/env bash
set -euo pipefail
umask 077
dnf install -y curl-minimal tar xz util-linux e2fsprogs python3 awscli-2 aws-workload-credentials-provider
id radar >/dev/null 2>&1 || useradd --system --create-home --shell /sbin/nologin radar
usermod -aG aws-wcp-token radar
install -d -m 0755 /opt/thread-watch-node
curl --fail --silent --show-error --location --max-time 120 https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz -o /var/tmp/radar-node.tar.xz
printf '%s  %s\n' 6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2 /var/tmp/radar-node.tar.xz | sha256sum --check --status
tar --extract --xz --file /var/tmp/radar-node.tar.xz --directory /opt/thread-watch-node --strip-components=1
rm /var/tmp/radar-node.tar.xz
radar_volume_id='${DataVolume}'
radar_nvme_name="nvme-Amazon_Elastic_Block_Store_$(printf '%s' "$radar_volume_id" | tr -d '-')"
radar_device="/dev/disk/by-id/$radar_nvme_name"
for radar_wait in $(seq 1 120); do
  test -b "$radar_device" && break
  sleep 2
done
test -b "$radar_device"
if ! blkid "$radar_device" >/dev/null 2>&1; then
  mkfs.ext4 "$radar_device"
fi
radar_uuid=$(blkid -s UUID -o value "$radar_device")
install -d -m 0700 /var/lib/thread-watch
printf 'UUID=%s /var/lib/thread-watch ext4 defaults,nodev,nosuid,noexec 0 2\n' "$radar_uuid" >> /etc/fstab
mount /var/lib/thread-watch
chown radar:radar /var/lib/thread-watch
chmod 0700 /var/lib/thread-watch
install -d -m 0700 /etc/thread-watch
cat > /etc/thread-watch/runtime.env <<'RADAR_ENV'
AWS_REGION=${AWS::Region}
RADAR_AWS_ACCOUNT_ID=${AWS::AccountId}
RADAR_TEAM_ID=${TeamId}
RADAR_USER_ID=${TargetUserId}
RADAR_APP_ID=${SlackAppId}
RADAR_CONFIRMED_SEPARATE_APP_ID=${SlackAppId}
RADAR_BOT_USER_ID=${BotUserId}
RADAR_BOT_ID=${BotId}
RADAR_PROCESSOR_USER_ID=${ProcessorUserId}
RADAR_RELAY_MEMBER_USER_IDS=${TargetUserId},${BotUserId},${ProcessorUserId}
RADAR_RELAY_VERIFIED_PRIVATE=${RelayVerifiedPrivate}
RADAR_ALLOW_SLACK_CONNECTION=approved
RADAR_ALLOW_SLACK_READS=approved
RADAR_ALLOW_PRIVATE_RELAY=approved
RADAR_RELAY_CHANNEL_ID=${RelayChannelId}
RADAR_WATCH_CHANNEL_IDS=${WatchChannelIds}
RADAR_ALLOW_CHANNEL_MONITORING=approved
RADAR_FOLLOW_MENTION_THREADS=approved
RADAR_VERIFIED_APP_SCOPES=connections:write
RADAR_ALLOW_CONTINUOUS=approved
RADAR_DEPLOYMENT_APPROVED=approved
RADAR_DATA_DIRECTORY=/var/lib/thread-watch
RADAR_SLACK_SECRET_ARN=${SlackSecret}
RADAR_ENV
chmod 0600 /etc/thread-watch/runtime.env
printf '%s\n' 'Radar bootstrap ready. Slack runtime remains stopped pending code and secure activation.'
'''

def template():
    r = {
        'Vpc': {'Type': 'AWS::EC2::VPC', 'Properties': {'CidrBlock': '172.29.240.0/24', 'EnableDnsSupport': True, 'EnableDnsHostnames': True,
            'Tags': [{'Key': 'Name', 'Value': sub('${AWS::StackName}-vpc')}]}},
        'Gateway': {'Type': 'AWS::EC2::InternetGateway'},
        'GatewayAttachment': {'Type': 'AWS::EC2::VPCGatewayAttachment', 'Properties': {'VpcId': ref('Vpc'), 'InternetGatewayId': ref('Gateway')}},
        'Subnet': {'Type': 'AWS::EC2::Subnet', 'Properties': {'VpcId': ref('Vpc'), 'AvailabilityZone': ref('AvailabilityZone'), 'CidrBlock': '172.29.240.0/26'}},
        'RouteTable': {'Type': 'AWS::EC2::RouteTable', 'Properties': {'VpcId': ref('Vpc')}},
        'Route': {'Type': 'AWS::EC2::Route', 'DependsOn': 'GatewayAttachment', 'Properties': {'RouteTableId': ref('RouteTable'), 'DestinationCidrBlock': '0.0.0.0/0', 'GatewayId': ref('Gateway')}},
        'RouteAssociation': {'Type': 'AWS::EC2::SubnetRouteTableAssociation', 'Properties': {'SubnetId': ref('Subnet'), 'RouteTableId': ref('RouteTable')}},
        'SecurityGroup': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {'GroupDescription': 'Radar outbound HTTPS and package updates; no inbound ports', 'VpcId': ref('Vpc'), 'SecurityGroupIngress': [],
            'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': p, 'ToPort': p, 'CidrIp': '0.0.0.0/0'} for p in (80, 443)]}},
        'Artifacts': {'Type': 'AWS::S3::Bucket', 'DeletionPolicy': 'Retain', 'UpdateReplacePolicy': 'Retain', 'Properties': {
            'PublicAccessBlockConfiguration': {'BlockPublicAcls': True, 'BlockPublicPolicy': True, 'IgnorePublicAcls': True, 'RestrictPublicBuckets': True},
            'OwnershipControls': {'Rules': [{'ObjectOwnership': 'BucketOwnerEnforced'}]},
            'BucketEncryption': {'ServerSideEncryptionConfiguration': [{'ServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}}]},
            'VersioningConfiguration': {'Status': 'Enabled'},
            'LifecycleConfiguration': {'Rules': [{'Id': 'expire-old-code', 'Status': 'Enabled', 'NoncurrentVersionExpiration': {'NoncurrentDays': 7}, 'AbortIncompleteMultipartUpload': {'DaysAfterInitiation': 1}}]}}},
        'ArtifactPolicy': {'Type': 'AWS::S3::BucketPolicy', 'Properties': {'Bucket': ref('Artifacts'), 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
            {'Effect': 'Deny', 'Principal': '*', 'Action': 's3:*', 'Resource': [arn('Artifacts'), sub('${Artifacts.Arn}/*')], 'Condition': {'Bool': {'aws:SecureTransport': 'false'}}}]}}},
        'SlackSecret': {'Type': 'AWS::SecretsManager::Secret', 'DeletionPolicy': 'Retain', 'UpdateReplacePolicy': 'Retain', 'Properties': {
            'Name': sub('${AWS::StackName}/slack'), 'Description': 'Owner-managed existing Radar Slack tokens. Agent must never read values.'}},
        'WorkerRole': {'Type': 'AWS::IAM::Role', 'Properties': {
            'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'ec2.amazonaws.com'}, 'Action': 'sts:AssumeRole'}]},
            'ManagedPolicyArns': [sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore')],
            'Policies': [{'PolicyName': 'RadarOnly', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
                {'Effect': 'Allow', 'Action': ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], 'Resource': ref('SlackSecret')},
                {'Effect': 'Allow', 'Action': ['s3:GetObject'], 'Resource': sub('${Artifacts.Arn}/releases/*')}]}}]}},
        'WorkerProfile': {'Type': 'AWS::IAM::InstanceProfile', 'Properties': {'Roles': [ref('WorkerRole')]}},
        'DataVolume': {'Type': 'AWS::EC2::Volume', 'DeletionPolicy': 'Retain', 'UpdateReplacePolicy': 'Retain', 'Properties': {
            'AvailabilityZone': ref('AvailabilityZone'), 'Size': 1, 'VolumeType': 'gp3', 'Encrypted': True,
            'Tags': [{'Key': 'Name', 'Value': sub('${AWS::StackName}-queue')}, {'Key': 'Project', 'Value': 'thread-watch'}]}},
        'Worker': {'Type': 'AWS::EC2::Instance', 'DependsOn': ['Route', 'RouteAssociation'], 'Properties': {
            'ImageId': ref('AmiId'), 'InstanceType': 't4g.micro', 'IamInstanceProfile': ref('WorkerProfile'),
            'NetworkInterfaces': [{'DeviceIndex': '0', 'AssociatePublicIpAddress': True, 'SubnetId': ref('Subnet'), 'GroupSet': [ref('SecurityGroup')]}],
            'MetadataOptions': {'HttpTokens': 'required', 'HttpEndpoint': 'enabled', 'HttpPutResponseHopLimit': 1},
            'CreditSpecification': {'CPUCredits': 'standard'},
            'BlockDeviceMappings': [{'DeviceName': '/dev/xvda', 'Ebs': {'VolumeSize': 8, 'VolumeType': 'gp3', 'Encrypted': True, 'DeleteOnTermination': True}}],
            'UserData': {'Fn::Base64': sub(BOOTSTRAP)},
            'Tags': [{'Key': 'Name', 'Value': sub('${AWS::StackName}-worker')}, {'Key': 'Project', 'Value': 'thread-watch'}]}},
        'DataAttachment': {'Type': 'AWS::EC2::VolumeAttachment', 'Properties': {'InstanceId': ref('Worker'), 'VolumeId': ref('DataVolume'), 'Device': '/dev/sdf'}}
    }
    return {'AWSTemplateFormatVersion': '2010-09-09', 'Description': 'Isolated Thread Watch continuous Slack mention relay; owner enters existing tokens privately.',
        'Parameters': {'AvailabilityZone': {'Type': 'AWS::EC2::AvailabilityZone::Name'},
            'AmiId': {'Type': 'AWS::EC2::Image::Id'},
            **{name: {'Type': 'String', 'AllowedPattern': prefix + '[A-Z0-9]+'} for name, prefix in (
                ('TeamId', 'T'), ('TargetUserId', 'U'), ('SlackAppId', 'A'), ('BotUserId', 'U'),
                ('BotId', 'B'), ('ProcessorUserId', 'U'), ('RelayChannelId', '[CG]'))},
            'RelayVerifiedPrivate': {'Type': 'String', 'AllowedValues': ['denied', 'approved'], 'Default': 'denied'},
            'WatchChannelIds': {'Type': 'String', 'Default': '', 'AllowedPattern': '(?:[CG][A-Z0-9]+(?:,[CG][A-Z0-9]+)*)?'}},
        'Resources': r, 'Outputs': {
            'WorkerId': {'Value': ref('Worker'), 'Description': 'Dedicated Radar instance for SSM administration'},
            'ArtifactBucket': {'Value': ref('Artifacts'), 'Description': 'Private code-only source artifact bucket'},
            'SlackSecretArn': {'Value': ref('SlackSecret'), 'Description': 'Non-secret ARN for owner-private credential entry'},
            'DataVolumeId': {'Value': ref('DataVolume'), 'Description': 'Encrypted queue disk retained on stack deletion'}}}

if __name__ == '__main__':
    target = Path(__file__).with_name('stack.json')
    target.write_text(json.dumps(template(), indent=2) + '\n')
    print('Generated local Radar stack: ' + str(target))
