cask "lhic-control-center" do
  version "0.2.3"

  on_arm do
    url "https://github.com/chengmatt416/LHIC/releases/download/desktop-v#{version}/lhic-control-center-mac-#{version}-arm64.dmg"
    sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end
  on_intel do
    url "https://github.com/chengmatt416/LHIC/releases/download/desktop-v#{version}/lhic-control-center-mac-#{version}-x64.dmg"
    sha256 "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  end

  name "LHIC Control Center"
  desc "Local Human Intent Controller desktop app — omp agent, browser and desktop control"
  homepage "https://github.com/chengmatt416/LHIC"

  app "LHIC Control Center.app"

  zap trash: [
    "~/Library/Application Support/lhic-control-center",
    "~/Library/Caches/lhic-desktop",
    "~/Library/Preferences/lhic-control-center.plist",
  ]
end
