# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.2.3/relay-0.2.3.tar.gz"
  sha256 "5abb07b7e0f7c32e5f192422e74364bc3e58175d182e671a84c946d21346d2be"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.2.3"
    sha256 cellar: :any, arm64_tahoe:   "e940c37c8b2043a42ba25fd1ad18a2cce2670fe7d989b2f89afff952d841467c"
    sha256 cellar: :any, arm64_sequoia: "05ceb2cfdd9486cab603116476e05713389e353142031857b9778c9a50140815"
    sha256 cellar: :any, tahoe:         "4fe4c26653a99a3da8a9a42262fdca2d7d9df737b5e24c1789792cf2260499d5"
    sha256 cellar: :any, sequoia:       "494a5dbb68ed2a34074235c2ba7990d60f5f0e3a7178510e0e8a34873406da6a"
  end

  depends_on "node@22"

  def install
    system "npm", "ci", "--no-audit", "--fund=false"
    system "npm", "run", "build"
    # Relay runs the user's own Claude Code, so drop the Agent SDK's bundled
    # binary (~219MB) and the peer packages only its unused entry points load.
    system "npm", "prune", "--omit=peer", "--no-audit", "--fund=false"
    rm_r Dir["node_modules/@anthropic-ai/claude-agent-sdk-*"]

    libexec.install "dist-server", "node_modules"
    (libexec/"dist").install "dist/web"
  end

  def post_install
    (var/"log").mkpath
    require "securerandom"
    require "socket"
    token_path = Pathname.new(Dir.home)/".relay-web"/"auth-token"
    unless token_path.exist?
      token_path.dirname.mkpath
      token_path.write(SecureRandom.hex(32))
      token_path.chmod(0600)
    end
    puts "Relay uses port 3003 and is protected by a local access token."
    puts "Start the background service with: brew services start bobtthp/relay/relay"
    puts "On this Mac: http://127.0.0.1:3003"
    lan_addresses = Socket.ip_address_list.filter_map do |address|
      address.ip_address if address.ipv4? && !address.ipv4_loopback?
    end.uniq
    lan_addresses.each { |address| puts "On this local network: http://#{address}:3003" }
    token = token_path.read.strip
    puts
    puts ">>> RELAY ACCESS TOKEN — KEEP PRIVATE <<<"
    puts($stdout.tty? ? "\e[1;97;41m  #{token}  \e[0m" : "  #{token}  ")
    puts
    puts "To retrieve it later: cat #{File.join(Dir.home, ".relay-web", "auth-token")}"
    opoo "Use only on a trusted local network. Do not expose port 3003 to the public internet or forward it on your router."
  end

  service do
    run [Formula["node@22"].opt_bin/"node", opt_libexec/"dist-server/packages/agent/src/server.js"]
    keep_alive true
    working_dir opt_libexec
    environment_variables PATH: std_service_path_env,
                          PORT: "3003",
                          RELAY_HOST: "0.0.0.0"
    log_path var/"log/relay.log"
    error_log_path var/"log/relay-error.log"
    name macos: "dev.relay.agent"
  end
end
