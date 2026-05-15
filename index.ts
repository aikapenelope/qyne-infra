import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as tls from "@pulumi/tls";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const config = new pulumi.Config();
const location = config.get("location") || "hel1";         // Helsinki (CX43 available, ~€16/mo)
const serverType = config.get("serverType") || "cx43";     // 8 vCPU, 16 GB RAM, 160 GB NVMe

// SSH access: restrict to known IPs. Use "0.0.0.0/0" to allow all (not recommended).
// Configure with: pulumi config set --path 'sshAllowedIps[0]' '1.2.3.4/32'
const sshAllowedIps = config.getObject<string[]>("sshAllowedIps") || ["0.0.0.0/0", "::/0"];

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
    networkZone: "eu-central",
    ipRange: "10.0.1.0/24",
});

// ---------------------------------------------------------------------------
// Cloud-init: Docker + Dokploy + Data Directories
// ---------------------------------------------------------------------------
const cloudInit = `#cloud-config
package_update: true
package_upgrade: true
packages:
  - curl
  - jq
  - unattended-upgrades
  - fail2ban

runcmd:
  # Create Nova data directories on the server NVMe disk
  - mkdir -p /var/lib/nova/pg-nova
  - mkdir -p /var/lib/nova/pg-agno
  - mkdir -p /var/lib/nova/backups

  # --- SSH Hardening ---
  - |
    cat > /etc/ssh/sshd_config.d/99-hardening.conf << 'EOF'
    PasswordAuthentication no
    PermitRootLogin prohibit-password
    MaxAuthTries 3
    LoginGraceTime 30
    PermitEmptyPasswords no
    X11Forwarding no
    EOF
  - systemctl reload ssh || systemctl reload sshd || true

  # --- fail2ban ---
  - |
    cat > /etc/fail2ban/jail.local << 'EOF'
    [sshd]
    enabled = true
    port = ssh
    filter = sshd
    maxretry = 5
    bantime = 3600
    findtime = 600
    EOF
  - systemctl enable fail2ban
  - systemctl restart fail2ban

  # --- Kernel Hardening ---
  - |
    cat > /etc/sysctl.d/99-nova-hardening.conf << 'EOF'
    net.ipv4.conf.all.send_redirects = 0
    net.ipv4.conf.default.send_redirects = 0
    net.ipv6.conf.all.accept_redirects = 0
    net.ipv6.conf.default.accept_redirects = 0
    net.ipv4.icmp_echo_ignore_broadcasts = 1
    net.ipv4.conf.all.log_martians = 1
    EOF
  - sysctl --system

  # --- Docker Log Rotation ---
  - |
    cat > /etc/docker/daemon.json << 'EOF'
    {
      "log-driver": "json-file",
      "log-opts": {
        "max-size": "10m",
        "max-file": "3"
      }
    }
    EOF

  # Install Docker
  - curl -fsSL https://get.docker.com | sh

  # Install Dokploy (includes Traefik, Docker Swarm init)
  # Use custom addr pool to avoid CIDR conflict with Hetzner VPC (10.0.0.0/16)
  - export DOCKER_SWARM_INIT_ARGS="--default-addr-pool 172.20.0.0/16 --default-addr-pool-mask-length 24"
  - curl -sSL https://dokploy.com/install.sh | sh
`;

// ---------------------------------------------------------------------------
// Server: Nova CX43 (8 vCPU, 16 GB RAM, 160 GB NVMe)
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
// Firewall: HTTP/S + SSH
// ---------------------------------------------------------------------------
const firewall = new hcloud.Firewall("nova-firewall", {
    rules: [
        {
            direction: "in",
            protocol: "tcp",
            port: "22",
            sourceIps: sshAllowedIps,
            description: "SSH access (restricted to known IPs)",
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
export const networkId = network.id;
