# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.1.8/relay-0.1.8.tar.gz"
  sha256 "79cd0bb4866e24a60a5a7240400ee162feb70b4bbf729e3281b955d72d10d96a"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.1.8"
    sha256 cellar: :any, arm64_tahoe:   "5286709c4a56d577139aaf7d745cdd26a74a301d76aaf6024ca883fc4137c945"
    sha256 cellar: :any, arm64_sequoia: "2222d2d067b43e6d01dbe45a06c2c25fe56793825ec2b44869f1addb1373112b"
    sha256 cellar: :any, tahoe:         "b8c09cc7e864c1729a46e24b7e90dc0cd97475b95caa89167ac7b161376a7474"
    sha256 cellar: :any, sequoia:       "7be37513122d349dc0ca938fd30f84fd55ce082abf230cdd13677c4f21dd3a93"
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
    puts "Access token: cat #{File.join(Dir.home, ".relay-web", "auth-token")}"
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
