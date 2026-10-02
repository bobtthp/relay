# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.1.5/relay-0.1.5.tar.gz"
  sha256 "e11c8556fd64db5a3373a64043a9c6821b70a5b1a6904bf27135ba397bf17b04"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.1.5"
    sha256 cellar: :any, arm64_tahoe:   "4c19370d362b007ab414f7d972e9181f411ffa275ac342ea84e78e6a2dec650f"
    sha256 cellar: :any, arm64_sequoia: "dad82c54fadcc610a554ba501abfdd6c599711412f98b4204bf9cc395bde056d"
    sha256 cellar: :any, tahoe:         "c9db279b702596e10722a1ba319aea3b010f7691fffb1b277b5296a2595f76e0"
    sha256 cellar: :any, sequoia:       "a8e5ff8e20574a6be0a8c5519c92c2ff4c2ad5934bb42d76ce5ae159e5e629e4"
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
