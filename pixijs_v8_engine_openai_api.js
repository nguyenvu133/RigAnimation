/* =====================================================================
   PIXIJS V8 ENGINE PRO — ENTRY (đã chia thành module trong Add3/)
   ---------------------------------------------------------------------
   File này KHÔNG còn chứa code engine. Toàn bộ engine đã được tách thành
   các module classic-script trong Add3/ (dùng chung scope global):

     Add3/atlas.js          ATLAS_SOURCES, ATLAS_PARTS, LEGACY_PARTS,
                            PartAtlas, AutoNamer
     Add3/rig-core.js       ATTACH_ANCHOR, SpineRig, rigEase, sampleTrack,
                            AnimationSystem, EditorScene, Engine
     Add3/ui.js             DEFAULT_CLIPS + helper UI (setText, setStatus,
                            renderSpineBonesList, renderPartsLibrary,
                            renderDopesheet, updateClipHUD, togglePlayState,
                            toggleSkeletonView, switchCharacter,
                            autoNameParts, clearCustomCharacter,
                            autoRigSpine, exportSpineJSON, downloadPackage, toast)
     Add3/chat.js           Chat, ChatImages, ImageViewer, renderMd*, copyCode,
                            addChatMessage, sendChat, applyAICode
     Add3/apply-ai.js       SVG_GEN_PROMPT, aiGenerateSVG, aiGenerateRasterImage,
                            aiCreateCharacter, CLIP_PROMPT, aiGenerateClips,
                            SVG_CLIPS, parseAIJSON, applyAIJSON, applyAllAICode,
                            PART_ALIAS, PART_PRIMARY, applyAIRig, sanitizeClips
     Add3/models.js         sessions, renderHistory, loadSession, newChat,
                            RIG_MODEL_PREFERENCE, providerReady,
                            autoModelCandidates, autoPickRigModel,
                            PRO_RIG_PROMPT, askAndApply, deepseekProRig,
                            fallbackModelConfig, toggleSidebar,
                            AI_PROVIDERS, getAPIKey, ServerStatus,
                            checkServerStatus, serverHasKey, hasAPIKey,
                            openKeyModal, closeKeyModal, saveAllKeys,
                            clearAllKeys, changeModel, updateModelBadge,
                            updateKeyBadge, loadSavedModel
     Add3/svg-character.js  SVG_BONES, SVG_PART_ALIASES, SvgCharacter
     Add3/boot.js           waitForLibs, boot (window load), export global,
                            setLibraryTab, setWorkTab, initAssetDrop

   THỨ TỰ NẠP (xem pixijs_v8_engine_openai_api.html):
     spine_rig.js → assets_import.js →
     Add3/atlas.js → Add3/rig-core.js → Add3/ui.js → Add3/chat.js →
     Add3/apply-ai.js → Add3/models.js → Add3/svg-character.js →
     Add3/boot.js → rig_advanced.js → anim_ai.js →
     Add3/ai-pro-core.js → Add3/rig-auto-pro.js → Add3/anim-auto-pro.js →
     Add3/bridge.js

   Bản gốc trước khi tách: pixijs_v8_engine_openai_api.js.bak
   ===================================================================== */

/* Không có code ở đây — mọi thứ nằm trong Add3/*.js.
   File được giữ lại để các script/tool cũ vẫn tham chiếu được đường dẫn này. */
console.log('[engine] entry rỗng — engine đã chia thành module trong Add3/');
