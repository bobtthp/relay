# The release workflow renders this template, builds macOS bottles, and adds
# their checksums before committing Formula/relay.rb to the source repository.
class Relay < Formula
  desc "Local web interface and agent service for Codex sessions"
  homepage "https://github.com/bobtthp/relay"
  url "https://github.com/bobtthp/relay/releases/download/v0.1.7/relay-0.1.7.tar.gz"
  sha256 "f1ef5578eb380665652a3369890a382c2101fcfb89f8a3d72b846d855e734940"
  license "MIT"

  bottle do
    root_url "https://github.com/bobtthp/relay/releases/download/v0.1.7"
    sha256 cellar: :any, arm64_tahoe:   "499d4941d571fb0f5de753b8e8fc5858202d9b48861aeac9dbb49f0194df4734"
    sha256 cellar: :any, arm64_sequoia: "e9958eca421296f27ccf99a58e0be0d8ebff28b1cf4618ed792f2c9bb94feb33"
    sha256 cellar: :any, tahoe:         "5af319d4475912e0ef66a7179fa8f135a7f1847c624df0ef3635cbe883f4501d"
    sha256 cellar: :any, sequoia:       "0541def8664fca0f4fce7eed02f78ab758f6c0f82351cf84e75672b3a2fad3ef"
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
