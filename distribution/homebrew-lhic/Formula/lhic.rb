class Lhic < Formula
  desc "Local-first browser and global desktop intent controller"
  homepage "https://github.com/chengmatt416/LHIC"
  url "https://registry.npmjs.org/@pinyencheng/lhic/-/lhic-0.1.5.tgz"
  sha256 "17e95c29bd99671f871433c08ea66e4f4cfd46e97594c4349a7bc8d224284c8a"
  license "MIT OR Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "lhic", shell_output("#{bin}/lhic --help")
  end
end
