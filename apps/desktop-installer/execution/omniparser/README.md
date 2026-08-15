# OmniParser V2 fallback (DOM-invisible screens)

#

# Preferred install (weights download automatically on first use):

# pip install omni_parser_v2

#

# Alternative: clone the OmniParser repo and download the V2 weights, then

# point LHIC_OMNIPARSER_DIR at the checkout:

# git clone https://github.com/microsoft/OmniParser.git

# cd OmniParser

# huggingface-cli download microsoft/OmniParser-v2.0 icon_detect_v3/model.pt \

# --revision refs/pr/37 --local-dir weights

# for f in icon_caption/{config.json,generation_config.json,model.safetensors}; do

# huggingface-cli download microsoft/OmniParser-v2.0 "$f" --local-dir weights

# done

# mv weights/icon_caption weights/icon_caption_florence

#

# LHIC env:

# LHIC_OMNIPARSER_PYTHON python interpreter (default python3)

# LHIC_OMNIPARSER_DIR OmniParser repo checkout (repo mode)

# LHIC_EXECUTION_BACKEND auto | peekaboo | flaui | omniparser | native

#

# This layer only GROUNDS elements from a screenshot; input dispatch and

# approval stay in the LHIC executor (traditional coordinate layer).
