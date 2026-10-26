# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.2.2/relay-0.2.2.tar.gz"
  sha256 "99c93706ca576efd444e7820252801367bc2b0d37783bf6df546a5cdb59291d4"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.2.2"
    sha256 cellar: :any, arm64_tahoe:   "75de77042669bb0f1c4d63845b004df484b9cd3280677b1130dfc3f60d69e14d"
    sha256 cellar: :any, arm64_sequoia: "8e3dc2d49392aab0e8931a6135a9896227e05d31de93db8130902b54f39f2b21"
    sha256 cellar: :any, tahoe:         "488b2c353c1f188447368d1488300b5e0540c604629f3417d29c28a36c27598b"
    sha256 cellar: :any, sequoia:       "e1b458367122650e5bd4310b5430b7eabd9e0d4a5d683359a92ab929550be78e"
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
    puts "Relay uses port 3000 and is protected by a local access token."
    puts "Start the background service with: brew services start bobtthp/relay/relay"
    puts "On this Mac: http://127.0.0.1:3000"
    lan_addresses = Socket.ip_address_list.filter_map do |address|
      address.ip_address if address.ipv4? && !address.ipv4_loopback?
    end.uniq
    lan_addresses.each { |address| puts "On this local network: http://#{address}:3000" }
    token = token_path.read.strip
    puts
    puts ">>> RELAY ACCESS TOKEN — KEEP PRIVATE <<<"
    puts($stdout.tty? ? "\e[1;97;41m  #{token}  \e[0m" : "  #{token}  ")
    puts
    puts "To retrieve it later: cat #{File.join(Dir.home, ".relay-web", "auth-token")}"
    opoo "Use only on a trusted local network. Do not expose port 3000 to the public internet or forward it on your router."
  end

  service do
    run [Formula["node@22"].opt_bin/"node", opt_libexec/"dist-server/packages/agent/src/server.js"]
    keep_alive true
    working_dir opt_libexec
    environment_variables PATH: std_service_path_env,
                          PORT: "3000",
                          RELAY_HOST: "0.0.0.0"
    log_path var/"log/relay.log"
    error_log_path var/"log/relay-error.log"
    name macos: "dev.relay.agent"
  end
end
