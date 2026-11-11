# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.2.4/relay-0.2.4.tar.gz"
  sha256 "798fb701a8952c121c630f9075b2d5028a47fbfdef0cb1766b60caaf1a1c38da"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.2.4"
    sha256 cellar: :any, arm64_tahoe:   "9a9a91ec5030f15a41aa1cd0497f78330d9feb53fa1ede780a1a2f9aa2edcbb5"
    sha256 cellar: :any, arm64_sequoia: "1a38cf6c22641d02e1afacc0f1cd9798dd74e166a1c3fca5e7a2a57c887845fe"
    sha256 cellar: :any, tahoe:         "a2d9971c9a459c84663ea178554bde2a58eba7d605753f35a8e9996d13c1fb07"
    sha256 cellar: :any, sequoia:       "0945ca2d602ed3bd39e1475936eefbedc83c754ee18a1da04a3b4ee90d0903a0"
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
