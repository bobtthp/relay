# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.1.6/relay-0.1.6.tar.gz"
  sha256 "28aa3e18de6844209d18a28b1d3a78382f255dfee161642b9039f5d000d383f4"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.1.6"
    sha256 cellar: :any, arm64_tahoe:   "634e96b02e70157572d8c204eddcf4af80d6f4453d473d733c6ddc076c99df8c"
    sha256 cellar: :any, arm64_sequoia: "b9d4fa51c1d109b618fb0d7809e0a6f95ca3ab6b4b27c3216d888a5de7636d4b"
    sha256 cellar: :any, tahoe:         "b3304495b448c18b00cd11a4459c8fa9a27445e246a4acb3cc12d56832a06ca5"
    sha256 cellar: :any, sequoia:       "32efe05e28fced1c0914e23c8a38f318c70a4dd7dde30ee3379352073c2c1b62"
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
  end

  service do
    run [Formula["node@22"].opt_bin/"node", opt_libexec/"dist-server/packages/agent/src/server.js"]
    keep_alive true
    working_dir opt_libexec
    environment_variables PATH: std_service_path_env,
                          PORT: "3000",
                          RELAY_HOST: "127.0.0.1"
    log_path var/"log/relay.log"
    error_log_path var/"log/relay-error.log"
    name macos: "dev.relay.agent"
  end
end
