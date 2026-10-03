# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.1.12/relay-0.1.12.tar.gz"
  sha256 "ee4221c0829e74ac01015ca8c2836d3a4454e41cc7a0395595de7541b411e4ce"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.1.12"
    sha256 cellar: :any, arm64_tahoe:   "1c0ebf1a8b4176895e9728594d353ca3456e748c264052400bc36ff08f2b8994"
    sha256 cellar: :any, arm64_sequoia: "ccc9f632ac18d537876cb3a0720316567e4e91f97c9c13163b927304fc65d6d8"
    sha256 cellar: :any, tahoe:         "106dcf7b22a047d30d7cdcf0dfdfa7c280739a9ebfe38a489aa318a4b73b8d05"
    sha256 cellar: :any, sequoia:       "4d7d512adae2a3474525127ca6dd2137df4ea8e6a3814748e68ef9c16ddd6add"
  end

  depends_on "node@22"

  def install
    system "npm", "ci", "--no-audit", "--fund=false"
    system "npm", "run", "build"

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
