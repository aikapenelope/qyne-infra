import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as tls from "@pulumi/tls";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const config = new pulumi.Config();
const location = config.get("location") || "ash";          // Ashburn, VA
const serverType = config.get("serverType") || "cx42";     // 8 vCPU, 16 GB RAM
const volumeSize = config.getNumber("volumeSize") || 100;  // GB for PostgreSQL data

// ---------------------------------------------------------------------------
// SSH Key
// ---------------------------------------------------------------------------
const sshKeypair = new tls.PrivateKey("nova-ssh-keypair", {
    algorithm: "ED25519",
});

const sshKey = new hcloud.SshKey("nova-ssh-key", {
    publicKey: sshKeypair.publicKeyOpenssh,
});

// ---------------------------------------------------------------------------
// Private Network
// ---------------------------------------------------------------------------
const network = new hcloud.Network("nova-network", {
    ipRange: "10.0.0.0/16",
});

const subnet = new hcloud.NetworkSubnet("nova-subnet", {
    networkId: network.id.apply((id) => parseInt(id)),
    type: "cloud",
    networkZone: "us-east",
    ipRange: "10.0.1.0/24",
});

// ---------------------------------------------------------------------------
// Cloud-init: Docker + Dokploy
// ---------------------------------------------------------------------------
const cloudInit = `#cloud-config
package_update: true
package_upgrade: true
packages:
  - curl
  - jq
  - unattended-upgrades

# Mount the block storage volume at /mnt/storage
mounts:
  - ["/dev/disk/by-id/scsi-0HC_Volume_nova-volume", "/mnt/storage", "ext4", "discard,nofail,defaults", "0", "2"]

runcmd:
  # Create mount point
  - mkdir -p /mnt/storage

  # Format volume if not already formatted
  - |
    if ! blkid /dev/disk/by-id/scsi-0HC_Volume_nova-volume; then
      mkfs.ext4 -L nova-data /dev/disk/by-id/scsi-0HC_Volume_nova-volume
    fi
  - mount -a

  # Create PostgreSQL data directories on block storage
  - mkdir -p /mnt/storage/pg-nova
  - mkdir -p /mnt/storage/pg-agno
  - mkdir -p /mnt/storage/backups

  # Install Docker
  - curl -fsSL https://get.docker.com | sh

  # Install Dokploy (includes Traefik, Docker Swarm init)
  # Use custom addr pool to avoid CIDR conflict with Hetzner VPC (10.0.0.0/16)
  - export DOCKER_SWARM_INIT_ARGS="--default-addr-pool 172.20.0.0/16 --default-addr-pool-mask-length 24"
  - curl -sSL https://dokploy.com/install.sh | sh
`;

// ---------------------------------------------------------------------------
// Server: Nova CX42
// ---------------------------------------------------------------------------
const server = new hcloud.Server("nova-server", {
    serverType: serverType,
    location: location,
    image: "ubuntu-24.04",
    sshKeys: [sshKey.id],
    userData: cloudInit,
    backups: true,
    deleteProtection: true,
    rebuildProtection: true,
    networks: [{
        subnetId: subnet.id,
        ip: "10.0.1.10",
    }],
}, {
    dependsOn: [subnet],
    ignoreChanges: ["userData"],
});

// ---------------------------------------------------------------------------
// Block Storage Volume (PostgreSQL data)
// ---------------------------------------------------------------------------
const volume = new hcloud.Volume("nova-volume", {
    size: volumeSize,
    location: location,
    format: "ext4",
    deleteProtection: true,
});

const volumeAttachment = new hcloud.VolumeAttachment("nova-volume-attachment", {
    volumeId: volume.id.apply((id) => parseInt(id)),
    serverId: server.id.apply((id) => parseInt(id)),
    automount: true,
});

// ---------------------------------------------------------------------------
// Firewall: HTTP/S + SSH
// ---------------------------------------------------------------------------
const firewall = new hcloud.Firewall("nova-firewall", {
    rules: [
        {
            direction: "in",
            protocol: "tcp",
            port: "22",
            sourceIps: ["0.0.0.0/0", "::/0"],
            description: "SSH access",
        },
        {
            direction: "in",
            protocol: "tcp",
            port: "80",
            sourceIps: ["0.0.0.0/0", "::/0"],
            description: "HTTP (Traefik)",
        },
        {
            direction: "in",
            protocol: "tcp",
            port: "443",
            sourceIps: ["0.0.0.0/0", "::/0"],
            description: "HTTPS (Traefik)",
        },
    ],
});

const firewallAttachment = new hcloud.FirewallAttachment("nova-firewall-attachment", {
    firewallId: firewall.id.apply((id) => parseInt(id)),
    serverIds: [server.id.apply((id) => parseInt(id))],
});

// ---------------------------------------------------------------------------
// Stack Outputs
// ---------------------------------------------------------------------------
export const serverIpv4 = server.ipv4Address;
export const serverIpv6 = server.ipv6Address;
export const serverStatus = server.status;
export const serverPrivateIp = "10.0.1.10";
export const sshPrivateKey = pulumi.secret(sshKeypair.privateKeyOpenssh);
export const dokployUrl = pulumi.interpolate`http://${server.ipv4Address}:3000`;
export const volumeId = volume.id;
export const networkId = network.id;
