# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.1.10/relay-0.1.10.tar.gz"
  sha256 "3cdf05fe4104d53dceba09680083ca30f871c17b7fead043bc20ebbfd25df4cb"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.1.10"
    sha256 cellar: :any, arm64_tahoe:   "0d1c3955fecc17c3c5cf83c46c71c44b446ef2b9a7c03987bb12254f23a9a119"
    sha256 cellar: :any, arm64_sequoia: "b5805e2d46c42e487a5696b7fa4dbc83b3cef08122f59eb899e3ed22bd83ef7f"
    sha256 cellar: :any, tahoe:         "4d17c30c03c9c49ae21f72171d3e4c97e164d1f5505077aaaf412de4a71236dc"
    sha256 cellar: :any, sequoia:       "e919dc66446072bcd818a198cf314b366adae6a8c31975d5ce971985779c1006"
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
