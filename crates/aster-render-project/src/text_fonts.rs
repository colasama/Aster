use std::collections::{BTreeMap, BTreeSet};

use aster_text::{
    FontCatalog, FontCatalogConfig, FontDiscoveryConfig, FontRequest, FontSelection, FontStyle,
    NativeFont, ProjectFontConfig, ProjectFontResolution, ProjectFontSet,
};

use crate::{
    NativeProjectDocument, ProjectRenderError,
    text_style::{ProjectTextStyle, TextFontFamily},
};

pub(crate) struct TextFontChain {
    pub fonts: Vec<NativeFont>,
    pub selections: Vec<FontSelection>,
    pub deferred: Option<String>,
}

pub(crate) struct ProjectTextFonts {
    embedded: ProjectFontSet,
    platform: FontCatalog,
    chains: BTreeMap<String, TextFontChain>,
}

impl ProjectTextFonts {
    pub fn new(
        document: &NativeProjectDocument,
        platform: FontCatalog,
    ) -> Result<Self, ProjectRenderError> {
        let mut embedded = ProjectFontSet::new(ProjectFontConfig::default())?;
        embedded.replace(document.scene.text_sources().1)?;
        Ok(Self {
            embedded,
            platform,
            chains: BTreeMap::new(),
        })
    }

    pub fn discover(
        document: &NativeProjectDocument,
        discovery: &FontDiscoveryConfig,
        config: FontCatalogConfig,
    ) -> Result<FontCatalog, ProjectRenderError> {
        let mut names = BTreeSet::new();
        for layer in document.scene.text_sources().0 {
            for family in ProjectTextStyle::from_layer(layer)?.families {
                if let Ok(name) = Self::platform_name(&family) {
                    names.insert(name);
                }
            }
        }
        if names.len() > 256 {
            return Err(ProjectRenderError::Invalid(
                "requested text families exceed budget".into(),
            ));
        }
        let probe = FontRequest {
            families: names.into_iter().collect(),
            weight: 400.,
            width_percent: 100.,
            style: FontStyle::Normal,
        };
        let mut catalog = FontCatalog::new(config.clone())?;
        if probe.families.is_empty() {
            return Ok(catalog);
        }
        for file in discovery.discover(
            FontDiscoveryConfig::platform_roots(),
            discovery.max_discovery_files,
        )? {
            let loaded = file.load(discovery)?;
            let mut candidate = FontCatalog::new(FontCatalogConfig {
                max_catalog_bytes: discovery.max_font_bytes,
                ..config.clone()
            })?;
            // An unreadable installed face cannot supply a requested family. Budget exhaustion is fatal.
            match candidate.insert(loaded.clone()) {
                Ok(_) => {}
                Err(error @ aster_text::FontCatalogError::Limit(_)) => return Err(error.into()),
                Err(_) => continue,
            }
            if candidate.select(&probe)?.is_some() {
                catalog.insert(loaded)?;
            }
        }
        Ok(catalog)
    }

    pub fn resolve(
        &mut self,
        style: &ProjectTextStyle,
    ) -> Result<&TextFontChain, ProjectRenderError> {
        let key = serde_json::to_string(&(&style.families, style.weight, &style.italic))?;
        if !self.chains.contains_key(&key) {
            if self.chains.len() >= 256 {
                return Err(ProjectRenderError::Invalid(
                    "text font chain cache exceeds budget".into(),
                ));
            }
            let mut chain = TextFontChain {
                fonts: Vec::new(),
                selections: Vec::new(),
                deferred: None,
            };
            if let Some(font_style) = style.font_style() {
                for family in &style.families {
                    let family = match Self::platform_name(family) {
                        Ok(name) => name,
                        Err(reason) => {
                            chain.deferred = Some(reason);
                            break;
                        }
                    };
                    let request = FontRequest {
                        families: vec![family.clone()],
                        weight: style.weight,
                        width_percent: 100.,
                        style: font_style,
                    };
                    let (selection, bytes) =
                        match self.embedded.resolve(&request, &self.platform)? {
                            ProjectFontResolution::Native { selection, .. } => {
                                let bytes = self
                                    .embedded
                                    .face(selection.face)
                                    .ok_or_else(|| {
                                        ProjectRenderError::Invalid(
                                            "embedded text face disappeared".into(),
                                        )
                                    })?
                                    .1;
                                (selection, bytes)
                            }
                            ProjectFontResolution::Platform(selection) => {
                                let bytes = self
                                    .platform
                                    .face(selection.face)
                                    .ok_or_else(|| {
                                        ProjectRenderError::Invalid(
                                            "platform text face disappeared".into(),
                                        )
                                    })?
                                    .1;
                                (selection, bytes)
                            }
                            ProjectFontResolution::RetainedRaster {
                                font_id, reason, ..
                            } => {
                                chain.deferred =
                                    Some(format!("embedded font {font_id}: {reason:?}"));
                                break;
                            }
                            ProjectFontResolution::Missing => continue,
                        };
                    if (font_style != FontStyle::Normal && selection.style == FontStyle::Normal)
                        || (style.weight >= 600. && selection.weight < 600.)
                    {
                        chain.deferred =
                            Some(format!("font {family} requires unverified synthetic style"));
                        break;
                    }
                    if chain.selections.iter().any(|s| s == &selection) {
                        continue;
                    }
                    if chain.fonts.len() >= 16 {
                        return Err(ProjectRenderError::Invalid(
                            "text fallback chain exceeds budget".into(),
                        ));
                    }
                    chain.fonts.push(NativeFont::new(selection.clone(), bytes)?);
                    chain.selections.push(selection);
                }
            } else {
                chain.deferred = Some(format!("unsupported font style {}", style.italic));
            }
            if chain.fonts.is_empty() && chain.deferred.is_none() {
                chain.deferred = Some(format!(
                    "requested font families unavailable: {}",
                    style
                        .families
                        .iter()
                        .map(|f| f.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            self.chains.insert(key.clone(), chain);
        }
        self.chains
            .get(&key)
            .ok_or_else(|| ProjectRenderError::Invalid("text font chain absent".into()))
    }

    fn platform_name(family: &TextFontFamily) -> Result<String, String> {
        let name = &family.name;
        if family.quoted {
            return Ok(name.clone());
        }
        match name.to_ascii_lowercase().as_str() {
            "sans-serif" if cfg!(windows) => Ok("Arial".into()),
            "serif" if cfg!(windows) => Ok("Times New Roman".into()),
            "monospace" if cfg!(windows) => Ok("Courier New".into()),
            "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "system-ui"
            | "ui-serif" | "ui-sans-serif" | "ui-monospace" | "ui-rounded" | "math" | "emoji" => {
                Err(format!(
                    "platform generic family mapping unverified: {name}"
                ))
            }
            _ => Ok(name.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ProjectTextFonts, ProjectTextStyle};

    #[test]
    fn literal_generic_names_and_ecma_whitespace_stay_distinct()
    -> Result<(), Box<dyn std::error::Error>> {
        let names = ProjectTextStyle::families(
            "\u{feff}'serif', serif, FangSong, \"Brand, Display\", Noto\u{feff}Serif, Name\u{85}Face",
        )?;
        assert_eq!(
            names.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec![
                "serif",
                "serif",
                "FangSong",
                "Brand, Display",
                "Noto Serif",
                "Name\u{85}Face"
            ]
        );
        assert_eq!(ProjectTextFonts::platform_name(&names[0])?, "serif");
        assert_eq!(ProjectTextFonts::platform_name(&names[2])?, "FangSong");
        if cfg!(windows) {
            assert_eq!(
                ProjectTextFonts::platform_name(&names[1])?,
                "Times New Roman"
            );
        } else {
            assert!(ProjectTextFonts::platform_name(&names[1]).is_err());
        }
        Ok(())
    }
}
