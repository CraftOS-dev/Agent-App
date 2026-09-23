# Standard Rails boot: point Bundler at this app's Gemfile and set up the
# load path from it, so `bundle exec` and a direct `ruby` agree on gems.
ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)

require "bundler/setup"
