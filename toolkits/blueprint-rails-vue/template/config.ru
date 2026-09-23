# Standard Rails rackup: Puma loads this file (see config/puma.rb) and gets
# the initialized application.
require_relative "config/environment"

run Rails.application
Rails.application.load_server
