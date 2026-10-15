# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.1.15/relay-0.1.15.tar.gz"
  sha256 "dda3811c51d141ea0593a8970814cb224e0ea5649d121f1218ef15446fae4862"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.1.15"
    sha256 cellar: :any, arm64_tahoe:   "bd19cd2ec29c33e8e20d5f4d18e01dd465db09f35266ebd5ab10ce68e0e2f53b"
    sha256 cellar: :any, arm64_sequoia: "08cc3d73af5ae9225dd3a7d5e6389b854a5e7b8bbf40bd0b952e85aea2079f7c"
    sha256 cellar: :any, tahoe:         "d14a6665f8ace70a65c38e59b275b85491047d0492f0d2123694af4353bee67a"
    sha256 cellar: :any, sequoia:       "de78551b721924a3cfccafa13151adc675042c65624f34f081bf93ed96641399"
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
